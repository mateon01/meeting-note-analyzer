import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as sagemaker from "aws-cdk-lib/aws-sagemaker";
import * as sns from "aws-cdk-lib/aws-sns";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { notifyOn } from "./alarms.js";
import { repoPath, type ProjectConfig } from "./config.js";

export interface SttStackProps extends StackProps {
  config: ProjectConfig;
  dataBucket: s3.IBucket;
  alarmTopic: sns.ITopic;
}

/**
 * SageMaker async inference endpoint for CrisperWhisper 2.0 + pyannote, plus the x86 CodeBuild
 * project that downloads/converts model weights into the S3 prefix the endpoint mounts.
 */
export class SttStack extends Stack {
  readonly endpointName: string;
  readonly endpointArn: string;
  readonly successTopic: sns.Topic;
  readonly errorTopic: sns.Topic;
  readonly modelPrefix: string;

  constructor(scope: Construct, id: string, props: SttStackProps) {
    super(scope, id, props);
    const { config, dataBucket } = props;
    this.endpointName = `${config.projectName}-stt`;
    this.endpointArn = `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${this.endpointName}`;
    this.modelPrefix = `models/stt/${config.sttModelVariant}/`;

    // ---- model publisher (x86_64 CodeBuild: HF download -> CT2 conversion -> s3 sync) ----
    const publisherSrc = new Asset(this, "PublisherSrc", { path: repoPath("scripts/stt") });
    const publisher = new codebuild.Project(this, "ModelPublisher", {
      projectName: `${config.projectName}-stt-model-publisher`,
      description: "Downloads CrisperWhisper/pyannote weights, converts to CTranslate2, syncs to the data bucket",
      source: codebuild.Source.s3({ bucket: publisherSrc.bucket, path: publisherSrc.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.LARGE },
      timeout: Duration.hours(3),
      environmentVariables: {
        DATA_BUCKET: { value: dataBucket.bucketName },
        MODEL_VARIANT: { value: config.sttModelVariant },
        HF_TOKEN: { type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER, value: config.hfTokenSecretName },
      },
      logging: { cloudWatch: { logGroup: new logs.LogGroup(this, "PublisherLogs", { retention: logs.RetentionDays.ONE_MONTH }) } },
    });
    secrets.Secret.fromSecretNameV2(this, "HuggingFaceToken", config.hfTokenSecretName).grantRead(publisher);
    dataBucket.grantReadWrite(publisher, "models/*");
    dataBucket.grantRead(publisher);

    // ---- notification topics ----
    this.successTopic = new sns.Topic(this, "SttSuccess", { displayName: "stt-success" });
    this.errorTopic = new sns.Topic(this, "SttError", { displayName: "stt-error" });

    if (config.sttDeployEndpoint) {
      // ---- container image (built for linux/amd64 via buildx) ----
      const image = new ecr_assets.DockerImageAsset(this, "SttImage", {
        directory: repoPath("stt"),
        platform: ecr_assets.Platform.LINUX_AMD64,
        exclude: ["tests", ".venv", "models", "__pycache__"],
      });

      const role = new iam.Role(this, "ExecutionRole", {
        assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
        description: "SageMaker execution role for the STT async endpoint",
      });
      dataBucket.grantRead(role, "models/*");
      dataBucket.grantRead(role, "uploads/*");
      dataBucket.grantRead(role, "lecture-uploads/*");
      dataBucket.grantRead(role, "interview-uploads/*/audio.mp3");
      dataBucket.grantRead(role, "lecture-results/*/video/audio.mp3");
      dataBucket.grantReadWrite(role, "stt/*");
      this.successTopic.grantPublish(role);
      this.errorTopic.grantPublish(role);
      image.repository.grantPull(role);
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "cloudwatch:PutMetricData", "ecr:GetAuthorizationToken"],
          resources: ["*"],
        }),
      );

      const model = new sagemaker.CfnModel(this, "Model", {
        executionRoleArn: role.roleArn,
        primaryContainer: {
          image: image.imageUri,
          modelDataSource: {
            s3DataSource: { s3Uri: `s3://${dataBucket.bucketName}/${this.modelPrefix}`, s3DataType: "S3Prefix", compressionType: "None" },
          },
          environment: {
            MODEL_DIR: "/opt/ml/model",
            STT_BACKEND: "ct2",
            CRISPERWHISPER_SUBDIR: "crisperwhisper/ct2",
            PYANNOTE_SUBDIR: "pyannote/community-1",
            STT_MODEL_NAME: `CrisperWhisper2.0_${config.sttModelVariant}`,
            STT_MODEL_REVISION: config.sttModelRevision,
            HF_HOME: "/opt/ml/model/hf-cache",
            HF_HUB_OFFLINE: "1",
            ENABLE_DIARIZATION: "1",
            STT_DEFAULT_LANGUAGE: "ko",
            STT_MAX_NEW_TOKENS: "160",
            LOG_LEVEL: "INFO",
          },
        },
      });
      model.node.addDependency(role);

      const endpointConfig = new sagemaker.CfnEndpointConfig(this, "EndpointConfig", {
        productionVariants: [
          {
            variantName: "AllTraffic",
            modelName: model.attrModelName,
            initialInstanceCount: Math.max(1, config.sttMinInstances), // the endpoint config needs >= 1; autoscaling takes it to 0
            instanceType: config.sttInstanceType,
            containerStartupHealthCheckTimeoutInSeconds: 1800,
            modelDataDownloadTimeoutInSeconds: 1800,
          },
        ],
        asyncInferenceConfig: {
          clientConfig: { maxConcurrentInvocationsPerInstance: 1 },
          outputConfig: {
            s3OutputPath: `s3://${dataBucket.bucketName}/stt/output/`,
            s3FailurePath: `s3://${dataBucket.bucketName}/stt/failure/`,
            notificationConfig: { successTopic: this.successTopic.topicArn, errorTopic: this.errorTopic.topicArn },
          },
        },
      });

      const endpoint = new sagemaker.CfnEndpoint(this, "Endpoint", {
        endpointName: this.endpointName,
        endpointConfigName: endpointConfig.attrEndpointConfigName,
      });

      // ---- autoscaling on backlog per instance ----
      // Turn off (sttAutoscaling=false) for one deploy before changing the instance type: SageMaker refuses to change
      // the instance type of a variant that is still registered as an Application Auto Scaling target.
      if (config.sttAutoscaling) {
      const target = new appscaling.ScalableTarget(this, "ScalableTarget", {
        serviceNamespace: appscaling.ServiceNamespace.SAGEMAKER,
        resourceId: `endpoint/${this.endpointName}/variant/AllTraffic`,
        scalableDimension: "sagemaker:variant:DesiredInstanceCount",
        minCapacity: config.sttMinInstances,
        maxCapacity: config.sttMaxInstances,
      });
      target.node.addDependency(endpoint);
      target.scaleToTrackMetric("Backlog", {
        targetValue: 1,
        customMetric: new cloudwatch.Metric({
          namespace: "AWS/SageMaker",
          metricName: "ApproximateBacklogSizePerInstance",
          dimensionsMap: { EndpointName: this.endpointName },
          statistic: "Average",
          period: Duration.minutes(1),
        }),
        scaleInCooldown: Duration.minutes(10),
        scaleOutCooldown: Duration.minutes(2),
      });
      // Scale from zero: target tracking cannot leave 0 instances (the per-instance metric is undefined there), so a
      // step policy on HasBacklogWithoutCapacity starts the first instance as soon as a request is queued. Cold start
      // (instance + model load) is roughly 6-10 minutes; the async request waits in the queue meanwhile.
      if (config.sttMinInstances === 0) {
        target.scaleOnMetric("ScaleFromZero", {
          metric: new cloudwatch.Metric({
            namespace: "AWS/SageMaker",
            metricName: "HasBacklogWithoutCapacity",
            dimensionsMap: { EndpointName: this.endpointName },
            statistic: "Average",
            period: Duration.minutes(1),
          }),
          scalingSteps: [
            { upper: 0, change: 0 },
            { lower: 1, change: +1 },
          ],
          adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
          cooldown: Duration.minutes(5),
          evaluationPeriods: 1,
        });
      }
      }
      // A request older than 40 minutes means the queue is stuck (instance never came up or the job hangs).
      notifyOn(this, "SttQueueStuck", new cloudwatch.Metric({ namespace: "AWS/SageMaker", metricName: "ApproximateAgeOfOldestRequest", dimensionsMap: { EndpointName: this.endpointName }, statistic: "Maximum", period: Duration.minutes(5) }), props.alarmTopic, "STT async queue has a request older than 40 minutes", 2400);
    }

    new CfnOutput(this, "EndpointName", { value: this.endpointName });
    new CfnOutput(this, "ModelPrefix", { value: `s3://${dataBucket.bucketName}/${this.modelPrefix}` });
    new CfnOutput(this, "PublisherProject", { value: publisher.projectName });
  }
}
