import { ArnFormat, CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { ProjectConfig } from "./config.js";
import { nodeFn } from "./lambda-fn.js";

export interface ApiStackProps extends StackProps {
  config: ProjectConfig;
  dataBucket: s3.IBucket;
  table: ddb.ITable;
  lectureTable: ddb.ITable;
  issuerUrl: string;
  userPoolClientId: string;
  stateMachineArn: string;
  memoryId: string;
  memoryArn: string;
  chatMemoryId: string;
  chatMemoryArn: string;
  lectureApiFunction: lambda.IFunction;
  interviewApiFunction: lambda.IFunction;
  guestApiFunction: lambda.IFunction;
}

export class ApiStack extends Stack {
  readonly httpApi: apigw.HttpApi;
  readonly apiDomain: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, dataBucket, table } = props;
    const vapidSecret = secrets.Secret.fromSecretNameV2(this, "VapidSecret", config.vapidSecretName);

    const apiFn = nodeFn(this, "ApiFn", {
      entry: "services/api/src/handlers/api.ts",
      timeout: Duration.seconds(29),
      memorySize: 1024,
      environment: {
        UPLOAD_BASE_URL: config.siteUrl,
        TABLE_NAME: table.tableName,
        LECTURE_TABLE_NAME: props.lectureTable.tableName,
        DATA_BUCKET: dataBucket.bucketName,
        VAPID_SECRET_NAME: config.vapidSecretName,
        STATE_MACHINE_ARN: props.stateMachineArn,
        MEMORY_ID: props.memoryId,
        CHAT_MEMORY_ID: props.chatMemoryId,
      },
    });
    table.grantReadWriteData(apiFn);
    props.lectureTable.grantReadData(apiFn);
    dataBucket.grantReadWrite(apiFn);
    dataBucket.grantDelete(apiFn);
    vapidSecret.grantRead(apiFn);
    // Execution ARNs are arn:aws:states:<region>:<acct>:execution:<stateMachineName>:<executionName>.
    // (A string .replace() on the cross-stack token would silently do nothing.)
    const executionArns = this.formatArn({ service: "states", resource: "execution", resourceName: `${config.projectName}-pipeline:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StopExecution"], resources: [executionArns] }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: [props.stateMachineArn] }));
    // Deleting a meeting also removes its AgentCore Memory session events and per-meeting summary records.
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:ListEvents", "bedrock-agentcore:DeleteEvent", "bedrock-agentcore:ListMemoryRecords", "bedrock-agentcore:BatchDeleteMemoryRecords"], resources: [props.memoryArn, props.chatMemoryArn] }));

    this.httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: `${config.projectName}-api`,
      corsPreflight: {
        allowOrigins: [config.siteUrl || "http://localhost:5173", "http://localhost:5173"].filter((value, index, all) => all.indexOf(value) === index),
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.PATCH, apigw.CorsHttpMethod.DELETE, apigw.CorsHttpMethod.OPTIONS],
        maxAge: Duration.days(1),
      },
    });
    const authorizer = new HttpJwtAuthorizer("Jwt", props.issuerUrl, { jwtAudience: [props.userPoolClientId] });
    const integration = new HttpLambdaIntegration("ApiIntegration", apiFn);
    const routes: [string, apigw.HttpMethod[]][] = [
      ["/api/me", [apigw.HttpMethod.GET]],
      ["/api/meetings", [apigw.HttpMethod.GET, apigw.HttpMethod.POST]],
      ["/api/meetings/{id}", [apigw.HttpMethod.GET, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE]],
      ["/api/meetings/{id}/result", [apigw.HttpMethod.GET]],
      ["/api/meetings/{id}/complete-upload", [apigw.HttpMethod.POST]],
      ["/api/meetings/{id}/retry", [apigw.HttpMethod.POST]],
      ["/api/meetings/{id}/brief", [apigw.HttpMethod.POST]],
      ["/api/meetings/{id}/speakers", [apigw.HttpMethod.PATCH]],
      ["/api/push/subscription", [apigw.HttpMethod.PUT, apigw.HttpMethod.DELETE]],
      ["/api/push/vapid-public-key", [apigw.HttpMethod.GET]],
      ["/api/chat/sessions", [apigw.HttpMethod.GET, apigw.HttpMethod.POST]],
      ["/api/chat/sessions/{id}", [apigw.HttpMethod.DELETE]],
      ["/api/chat/sessions/{id}/messages", [apigw.HttpMethod.GET]],
    ];
    for (const [path, methods] of routes) this.httpApi.addRoutes({ path, methods, integration, authorizer });
    const lectureIntegration = new HttpLambdaIntegration("LectureIntegration", props.lectureApiFunction);
    const lectureRoutes: [string, apigw.HttpMethod[]][] = [
      ["/api/lectures", [apigw.HttpMethod.GET, apigw.HttpMethod.POST]],
      ["/api/lectures/{id}", [apigw.HttpMethod.GET, apigw.HttpMethod.DELETE]],
      ["/api/lectures/{id}/result", [apigw.HttpMethod.GET]],
      ["/api/lectures/{id}/shares", [apigw.HttpMethod.GET, apigw.HttpMethod.POST]],
      ["/api/lectures/{id}/shares/{shareId}", [apigw.HttpMethod.DELETE]],
      ...["complete-upload", "start", "retry"].map((action): [string, apigw.HttpMethod[]] => [`/api/lectures/{id}/${action}`, [apigw.HttpMethod.POST]]),
    ];
    for (const [path, methods] of lectureRoutes) this.httpApi.addRoutes({ path, methods, integration: lectureIntegration, authorizer });
    const guestIntegration = new HttpLambdaIntegration("GuestLectureIntegration", props.guestApiFunction);
    // These routes perform email-OTP/session verification themselves. The owner's
    // existing Cognito authorizer remains on every management and private-data route.
    for (const [path, method] of [
      ["/api/guest/lectures/{shareId}/request-code", apigw.HttpMethod.POST],
      ["/api/guest/lectures/{shareId}/verify-code", apigw.HttpMethod.POST],
      ["/api/guest/lectures/{shareId}", apigw.HttpMethod.GET],
      ["/api/guest/lectures/{shareId}/images/{imageId}", apigw.HttpMethod.GET],
      ["/api/guest/logout", apigw.HttpMethod.POST],
    ] as const) this.httpApi.addRoutes({ path, methods: [method], integration: guestIntegration });
    const interviewIntegration = new HttpLambdaIntegration("InterviewIntegration", props.interviewApiFunction);
    const interviewRoutes: [string, apigw.HttpMethod[]][] = [
      ["/api/interviews", [apigw.HttpMethod.GET, apigw.HttpMethod.POST]],
      ["/api/interviews/{id}", [apigw.HttpMethod.DELETE]],
      ["/api/interviews/{id}/result", [apigw.HttpMethod.GET]],
      ["/api/interviews/{id}/markdown", [apigw.HttpMethod.GET]],
      ["/api/interviews/{id}/settings", [apigw.HttpMethod.PATCH]],
      ...["complete-upload", "start", "retry"].map((action): [string, apigw.HttpMethod[]] => [`/api/interviews/{id}/${action}`, [apigw.HttpMethod.POST]]),
    ];
    for (const [path, methods] of interviewRoutes) this.httpApi.addRoutes({ path, methods, integration: interviewIntegration, authorizer });

    this.apiDomain = `${this.httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;
    new CfnOutput(this, "ApiUrl", { value: this.httpApi.apiEndpoint });
  }
}
