import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import type * as sns from "aws-cdk-lib/aws-sns";
import { lambdaErrorsAlarm } from "./alarms.js";
import { ChatStreamFn } from "./chat-stream-fn.js";
import { repoPath, type ProjectConfig } from "./config.js";

export interface WebStackProps extends StackProps {
  /** Data bucket; presigned upload URLs are served through this distribution under /uploads/*. */
  dataBucket: s3.IBucket;
  config: ProjectConfig;
  apiDomain: string;
  /** Chat streaming relay (served under /api/chat-stream, ahead of the /api/* API behavior). */
  table: ddb.ITable;
  userPoolId: string;
  userPoolClientId: string;
  chatRuntimeArn: string;
  chatRuntimeVersion: string;
  alarmTopic: sns.ITopic;
  /** Runtime config served at /config.json (Cognito ids etc.). */
  webConfig: Record<string, string>;
}

/** Private S3 site served on the default CloudFront hostname, with API, upload and chat origins. */
export class WebStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config } = props;

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const noCache = new cloudfront.CachePolicy(this, "ShellNoCache", {
      cachePolicyName: `${config.projectName}-shell-nocache`,
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
    });
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);
    // SPA routing: rewrite extensionless viewer paths to index.html on the S3 behavior only
    // (a distribution-wide 404->index.html error response would also mask /api/* errors).
    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; var u = r.uri; if (u === '/' || u.startsWith('/api/')) { return r; } if (!u.split('/').pop().includes('.')) { r.uri = '/index.html'; } return r; }",
      ),
    });
    const apiOrigin = new origins.HttpOrigin(props.apiDomain, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY, readTimeout: Duration.seconds(30) });
    // The bucket as a plain HTTPS origin (no OAC): the presigned query-string signature is the only credential, and
    // CloudFront sends the bucket host to S3 so the signature stays valid. Lets phones upload without direct S3 access.
    const uploadOrigin = new origins.HttpOrigin(props.dataBucket.bucketRegionalDomainName, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY, readTimeout: Duration.seconds(60) });
    // Chat answers stream as server-sent events; the runtime emits a keepalive every 10s so the 60s origin read timeout never trips.
    // OAC: CloudFront signs origin requests (SigV4) for the IAM-auth Function URL; the app token travels in x-mna-token
    // because CloudFront overwrites Authorization, and POST bodies must carry x-amz-content-sha256 (client computes it).
    const chatStream = new ChatStreamFn(this, "ChatStream", { table: props.table, userPoolId: props.userPoolId, userPoolClientId: props.userPoolClientId, chatRuntimeArn: props.chatRuntimeArn, chatRuntimeVersion: props.chatRuntimeVersion });
    const chatOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(chatStream.url, { readTimeout: Duration.seconds(60) });
    lambdaErrorsAlarm(this, "ChatRelayErrors", chatStream.fn, props.alarmTopic, "Chat streaming relay Lambda failed");

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `${config.projectName} PWA`,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/interview-uploads/*": {
          origin: uploadOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "/lecture-uploads/*": {
          origin: uploadOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "/uploads/*": {
          origin: uploadOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "/api/chat-stream": {
          origin: chatOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        "/index.html": { origin: s3Origin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: noCache, compress: true },
        "/sw.js": { origin: s3Origin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: noCache, compress: true },
        "/manifest.webmanifest": { origin: s3Origin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: noCache, compress: true },
        "/config.json": { origin: s3Origin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: noCache, compress: true },
      },
    });
    // Function URL invocations check two actions. CDK's OAC helper grants only lambda:InvokeFunctionUrl to CloudFront;
    // without lambda:InvokeFunction (InvokedViaFunctionUrl) every request through the distribution is a 403.
    chatStream.fn.addPermission("InvokeViaUrlFromCloudFront", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: this.distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    const shellFiles = ["index.html", "sw.js", "manifest.webmanifest", "registerSW.js", "config.json"];
    new s3deploy.BucketDeployment(this, "DeployAssets", {
      destinationBucket: siteBucket,
      sources: [s3deploy.Source.asset(repoPath("web/dist"))],
      exclude: shellFiles,
      cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
      prune: false,
      memoryLimit: 1024,
    });
    new s3deploy.BucketDeployment(this, "DeployShell", {
      destinationBucket: siteBucket,
      sources: [s3deploy.Source.asset(repoPath("web/dist"), { exclude: ["assets", "assets/**"] }), s3deploy.Source.jsonData("config.json", { ...props.webConfig, appOrigin: `https://${this.distribution.distributionDomainName}` })],
      cacheControl: [s3deploy.CacheControl.fromString("no-cache, no-store, must-revalidate")],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      memoryLimit: 1024,
    });

    new CfnOutput(this, "SiteUrl", { value: `https://${this.distribution.distributionDomainName}` });
    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
  }
}
