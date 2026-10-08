import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";
import { lambdaErrorsAlarm } from "./alarms.js";
import { retainRuntimeLogs } from "./runtime-logs.js";
import { repoPath, type ProjectConfig } from "./config.js";
import { nodeFn } from "./lambda-fn.js";

export interface ChatStackProps extends StackProps {
  config: ProjectConfig;
  dataBucket: s3.IBucket;
  table: ddb.ITable;
  /** Pipeline memory (user facts, meeting summaries): the chat agent reads it. */
  pipelineMemoryId: string;
  pipelineMemoryArn: string;
  alarmTopic: sns.ITopic;
  /** Lecture table (separate stack): list_lectures / get_lecture read it with the owner check in runtime code. */
  lectureTable: ddb.ITable;
}

/**
 * Chatbot (beta): Bedrock Managed Knowledge Base over the meeting markdown in the data bucket, exposed to the chat
 * agent through an AgentCore Gateway (IAM inbound, knowledge-base connector target), an AgentCore Memory for
 * per-session summaries, the chat AgentCore Runtime (Claude Agent SDK) and the S3-event-driven ingestion trigger.
 * The response-streaming relay Lambda lives in the Web stack (CloudFront origin access control needs the same stack).
 */
export class ChatStack extends Stack {
  readonly chatMemoryId: string;
  readonly chatMemoryArn: string;
  readonly knowledgeBaseId: string;
  readonly gatewayUrl: string;
  readonly chatRuntimeArn: string;
  readonly chatRuntimeVersion: string;

  constructor(scope: Construct, id: string, props: ChatStackProps) {
    super(scope, id, props);
    const { config, dataBucket, table } = props;
    const safeName = config.projectName.replace(/[^a-zA-Z0-9_]/g, "_");
    const dashName = config.projectName.replace(/[^a-zA-Z0-9-]/g, "-");

    // ---- managed knowledge base (built-in vector store, managed embeddings, hybrid search + managed reranker) ----
    const kbRole = new iam.Role(this, "KbRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account }, ArnLike: { "aws:SourceArn": `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` } },
      }),
      description: "Managed knowledge base: reads meeting markdown from the data bucket",
    });
    dataBucket.grantRead(kbRole, "results/*");
    dataBucket.grantRead(kbRole, "lecture-results/*");
    dataBucket.grantRead(kbRole, "transcripts/*");
    kbRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: ["arn:aws:bedrock:*::foundation-model/*", `arn:aws:bedrock:*:${this.account}:inference-profile/*`] }));

    const kb = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${dashName}-meetings`,
      description: "Meeting documents and transcripts (markdown) with owner/meeting metadata for per-user filtering",
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: { type: "MANAGED", managedKnowledgeBaseConfiguration: { embeddingModelType: "MANAGED" } },
    });
    kb.node.addDependency(kbRole);
    this.knowledgeBaseId = kb.attrKnowledgeBaseId;

    const source = new bedrock.CfnDataSource(this, "KbSource", {
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      name: "meeting-markdown",
      description: "results/{meetingId}/document.md, transcripts/{meetingId}/transcript.md and lecture-results/{lectureId}/runs/{runId}/study.md with .metadata.json sidecars",
      dataDeletionPolicy: "DELETE",
      dataSourceConfiguration: {
        type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
        managedKnowledgeBaseConnectorConfiguration: {
          // CloudFormation wants a JSON object here (the API returns it as a string).
          connectorParameters: {
            type: "S3",
            version: "1",
            connectionConfiguration: { bucketName: dataBucket.bucketName, bucketOwnerAccountId: this.account },
            // Kendra-style connector: patterns are Java globs matched against the whole key, so a single "*" does not cross "/".
            // Verified 2026-09-06: ".*\\.md" and "*.md" scanned 0 objects, "**/*.md" scanned exactly the 12 markdown files.
            filterConfiguration: { inclusionPrefixes: ["results/", "transcripts/", "lecture-results/"], inclusionPatterns: ["**/*.md"], maxFileSizeInMegaBytes: "50" },
            aclEnabled: false,
          },
        },
      },
    });

    // ---- ingestion trigger: sidecar created (finalize) or markdown deleted (meeting removed) ----
    const ingestFn = nodeFn(this, "KbIngestFn", {
      entry: "services/pipeline/src/handlers/kb-ingest.ts",
      timeout: Duration.minutes(12),
      memorySize: 256,
      environment: { KNOWLEDGE_BASE_ID: kb.attrKnowledgeBaseId, DATA_SOURCE_ID: source.attrDataSourceId },
    });
    ingestFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock:StartIngestionJob", "bedrock:ListIngestionJobs", "bedrock:GetIngestionJob"], resources: [kb.attrKnowledgeBaseArn] }));
    const objectRule = (ruleId: string, detailType: string, keys: string[]) =>
      new events.Rule(this, ruleId, {
        description: `${detailType} on ${keys.join(", ")} -> knowledge base ingestion`,
        eventPattern: { source: ["aws.s3"], detailType: [detailType], detail: { bucket: { name: [dataBucket.bucketName] }, object: { key: keys.map((wildcard) => ({ wildcard })) } } },
        targets: [new targets.LambdaFunction(ingestFn, { retryAttempts: 2 })],
      });
    objectRule("IngestOnSidecar", "Object Created", ["results/*/document.md.metadata.json", "transcripts/*/transcript.md.metadata.json", "lecture-results/*/runs/*/study.md.metadata.json"]);
    objectRule("IngestOnDelete", "Object Deleted", ["results/*/document.md", "transcripts/*/transcript.md", "lecture-results/*/runs/*/study.md"]);
    lambdaErrorsAlarm(this, "KbIngestErrors", ingestFn, props.alarmTopic, "Knowledge base ingestion trigger failed (new meetings may not be searchable)");

    // ---- gateway: IAM callers only (the chat runtime role), knowledge-base Retrieve out ----
    // A JWT authorizer would let any signed-in user call Retrieve directly with a filter of their choice; the owner filter
    // is enforced in runtime code, so only the runtime may reach the gateway.
    const gatewayRole = new iam.Role(this, "GatewayRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": this.account } } }),
      description: "AgentCore Gateway execution role: Retrieve on the meetings knowledge base",
    });
    gatewayRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock:Retrieve", "bedrock:GetKnowledgeBase"], resources: [kb.attrKnowledgeBaseArn] }));
    gatewayRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock:Rerank", "bedrock:InvokeModel"], resources: ["*"] }));

    // The authorizer type of an existing gateway cannot be changed in place, so the IAM gateway is a new resource
    // (new logical id and name); CloudFormation creates it, repoints the runtime, then deletes the JWT one.
    const gateway = new agentcore.CfnGateway(this, "KbGatewayIam", {
      name: `${dashName}-kb-gateway-iam`,
      description: "Meeting and lecture knowledge base tools for the chat agent (inbound: IAM, runtime role only)",
      protocolType: "MCP",
      authorizerType: "AWS_IAM",
      roleArn: gatewayRole.roleArn,
      exceptionLevel: "DEBUG",
    });
    gateway.node.addDependency(gatewayRole);
    this.gatewayUrl = gateway.attrGatewayUrl;

    const target = new agentcore.CfnGatewayTarget(this, "KbTargetIam", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "managed-kb",
      description: "Retrieve (hybrid search + managed reranker) over the meetings knowledge base; the caller supplies the query and the metadata filter",
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: "bedrock-knowledge-bases" },
            enabled: ["Retrieve"],
            configurations: [
              {
                name: "Retrieve",
                parameterValues: { knowledgeBaseId: kb.attrKnowledgeBaseId, retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: 8, rerankingModelType: "MANAGED" } } },
                parameterOverrides: [
                  { path: "$.retrievalQuery.text", visible: true, description: "Search query" },
                  { path: "$.retrievalConfiguration.managedSearchConfiguration.filter", visible: true, description: "Metadata filter (owner, meetingId)" },
                  { path: "$.retrievalConfiguration.managedSearchConfiguration.numberOfResults", visible: true, description: "Result count" },
                ],
              },
            ],
          },
        },
      },
    });
    target.node.addDependency(kb);

    // ---- chat memory: per-session conversation summaries ----
    const memoryRole = new iam.Role(this, "ChatMemoryRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "Execution role for chat memory summarization",
    });
    memoryRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: ["arn:aws:bedrock:*::foundation-model/*", `arn:aws:bedrock:*:${this.account}:inference-profile/*`] }));
    const memory = new agentcore.CfnMemory(this, "ChatMemory", {
      name: `${safeName}_chat_memory`,
      description: "Chat sessions: conversational events per session + summaries for context overflow",
      eventExpiryDuration: 90,
      memoryExecutionRoleArn: memoryRole.roleArn,
      memoryStrategies: [{ summaryMemoryStrategy: { name: "chat_summary", description: "Running summary of one chat session", namespaces: ["/chat/{actorId}/{sessionId}"] } }],
    });
    this.chatMemoryId = memory.attrMemoryId;
    this.chatMemoryArn = memory.attrMemoryArn;

    // ---- chat runtime ----
    const image = new ecr_assets.DockerImageAsset(this, "ChatImage", {
      directory: repoPath("agents"),
      file: "Dockerfile.chat",
      platform: ecr_assets.Platform.LINUX_ARM64,
      exclude: ["tests", ".venv", "__pycache__", ".pytest_cache"],
    });
    const role = new iam.Role(this, "ChatRuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account }, ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` } },
      }),
      description: "Execution role for the meeting-chat AgentCore runtime",
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockInvoke",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["arn:aws:bedrock:*::foundation-model/*", `arn:aws:bedrock:*:${this.account}:inference-profile/*`, `arn:aws:bedrock:*:${this.account}:application-inference-profile/*`],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: "BedrockDiscover", actions: ["bedrock:ListInferenceProfiles", "bedrock:GetInferenceProfile"], resources: ["*"] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "MemoryDataPlane",
        actions: ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:GetEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:ListMemoryRecords", "bedrock-agentcore:GetMemoryRecord", "bedrock-agentcore:ListSessions", "bedrock-agentcore:ListActors"],
        resources: [this.chatMemoryArn, props.pipelineMemoryArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Observability",
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups", "xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets", "ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: "Metrics", actions: ["cloudwatch:PutMetricData"], resources: ["*"], conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } } }));
    role.addToPolicy(new iam.PolicyStatement({ sid: "WorkloadIdentity", actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId"], resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`, `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: "GatewayRetrieve", actions: ["bedrock-agentcore:InvokeGateway"], resources: [gateway.attrGatewayArn] }));
    image.repository.grantPull(role);
    dataBucket.grantRead(role, "transcripts/*");
    dataBucket.grantRead(role, "results/*");
    dataBucket.grantRead(role, "lecture-results/*");
    table.grantReadWriteData(role);
    props.lectureTable.grantReadData(role);

    const runtime = new agentcore.CfnRuntime(this, "ChatRuntime", {
      agentRuntimeName: `${safeName}_meeting_chat`,
      description: "Meeting chat agent (beta): Claude Agent SDK on Bedrock Sonnet 5, evidence from the managed knowledge base through the gateway",
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.imageUri } },
      roleArn: role.roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      environmentVariables: {
        AWS_REGION: this.region,
        DATA_BUCKET: dataBucket.bucketName,
        TABLE_NAME: table.tableName,
        LECTURE_TABLE_NAME: props.lectureTable.tableName,
        MEMORY_ID: props.pipelineMemoryId,
        CHAT_MEMORY_ID: this.chatMemoryId,
        GATEWAY_URL: this.gatewayUrl,
        WEB_ORIGIN: config.siteUrl,
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: config.opusModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: config.sonnetModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: config.haikuModel,
        ANTHROPIC_SMALL_FAST_MODEL: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        ENABLE_PROMPT_CACHING_1H: "1",
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "0",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        DISABLE_TELEMETRY: "1",
        HOME: "/home/agent",
        CLAUDE_CONFIG_DIR: "/home/agent/.claude",
        LOG_LEVEL: "INFO",
      },
    });
    runtime.node.addDependency(role);
    this.chatRuntimeArn = runtime.attrAgentRuntimeArn;
    // A literal build revision avoids exporting a changing CloudFormation value
    // while allowing existing conversations to use the updated runtime code.
    this.chatRuntimeVersion = image.assetHash;
    retainRuntimeLogs(this, "ChatRuntimeLogRetention", runtime.attrAgentRuntimeId);

    new CfnOutput(this, "KnowledgeBaseId", { value: this.knowledgeBaseId });
    new CfnOutput(this, "DataSourceId", { value: source.attrDataSourceId });
    new CfnOutput(this, "GatewayUrl", { value: this.gatewayUrl });
    new CfnOutput(this, "ChatMemoryId", { value: this.chatMemoryId });
    new CfnOutput(this, "ChatRuntimeArn", { value: runtime.attrAgentRuntimeArn });
  }
}
