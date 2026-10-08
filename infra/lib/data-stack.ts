import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { ProjectConfig } from "./config.js";
import { nodeFn } from "./lambda-fn.js";

export interface DataStackProps extends StackProps {
  config: ProjectConfig;
}

/** Tier retained media and lecture results; expire temporary STT files. */
export function dataLifecycleRules(): s3.LifecycleRule[] {
  const tiering = { transitions: [{ storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(0) }] };
  return [
    { prefix: "stt/", expiration: Duration.days(30) },
    { abortIncompleteMultipartUploadAfter: Duration.days(2) },
    { noncurrentVersionExpiration: Duration.days(30) },
    { prefix: "uploads/", ...tiering },
    { prefix: "lecture-uploads/", ...tiering },
    { prefix: "lecture-results/", ...tiering },
    { prefix: "interview-uploads/", ...tiering },
    { prefix: "interview-results/", ...tiering },
  ];
}

/** Durable storage and optional operator notifications. */
export class DataStack extends Stack {
  readonly dataBucket: s3.Bucket;
  readonly table: ddb.Table;
  /** Operator notifications: every stack's failure alarms publish here. */
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: `${config.projectName}-data-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      eventBridgeEnabled: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [config.siteUrl || "http://localhost:5173", "http://localhost:5173"].filter((value, index, all) => all.indexOf(value) === index),
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3600,
        },
      ],
      lifecycleRules: dataLifecycleRules(),
    });

    this.table = new ddb.Table(this, "Table", {
      tableName: `${config.projectName}-main`,
      partitionKey: { name: "PK", type: ddb.AttributeType.STRING },
      sortKey: { name: "SK", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: ddb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", { displayName: `${config.projectName} alarms` });
    if (config.alarmEmail) this.alarmTopic.addSubscription(new subs.EmailSubscription(config.alarmEmail));

    // Slack delivery: the operator pastes an Incoming Webhook URL into this secret (scripts/set-slack-webhook.sh);
    // until then the forwarder logs and drops alarms. Korean formatting lives in the Lambda, not in AWS Chatbot.
    if (config.enableSlackAlarms) {
      const slackSecret = new secrets.Secret(this, "SlackWebhookSecret", {
        secretName: `${config.projectName}/slack-webhook`,
        description: "Slack Incoming Webhook URL for operator alarms (plain string or {\"url\": ...})",
        secretStringValue: SecretValue.unsafePlainText("not-configured"),
    });
    const slackFn = nodeFn(this, "SlackAlarmFn", {
      entry: "services/pipeline/src/handlers/slack-alarm.ts",
      timeout: Duration.seconds(20),
      memorySize: 256,
      environment: { SLACK_WEBHOOK_SECRET_NAME: slackSecret.secretName },
    });
    slackSecret.grantRead(slackFn);
    this.alarmTopic.addSubscription(new subs.LambdaSubscription(slackFn));
    }
    new CfnOutput(this, "DataBucketName", { value: this.dataBucket.bucketName });
    new CfnOutput(this, "TableName", { value: this.table.tableName });
    new CfnOutput(this, "AlarmTopicArn", { value: this.alarmTopic.topicArn });
  }
}
