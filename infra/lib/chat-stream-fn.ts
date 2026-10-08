import { Duration } from "aws-cdk-lib";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { nodeFn } from "./lambda-fn.js";

export interface ChatStreamFnProps {
  table: ddb.ITable;
  userPoolId: string;
  userPoolClientId: string;
  chatRuntimeArn: string;
  chatRuntimeVersion: string;
}

/**
 * Response-streaming relay between the web app and the chat AgentCore runtime. Lives in the Web stack so CloudFront
 * can front its Function URL with origin access control (IAM-signed origin requests, no public invoke permission):
 * a Function URL with AuthType NONE lost its public permission within minutes in this account.
 */
export class ChatStreamFn extends Construct {
  readonly fn: lambda.Function;
  readonly url: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: ChatStreamFnProps) {
    super(scope, id);
    const fn = nodeFn(this, "Fn", {
      entry: "services/api/src/handlers/chat-stream.ts",
      timeout: Duration.minutes(15),
      memorySize: 512,
      environment: { TABLE_NAME: props.table.tableName, USER_POOL_ID: props.userPoolId, USER_POOL_CLIENT_ID: props.userPoolClientId, CHAT_RUNTIME_ARN: props.chatRuntimeArn, CHAT_RUNTIME_VERSION: props.chatRuntimeVersion },
    });
    props.table.grantReadData(fn);
    // Both actions are checked when the X-Amzn-Bedrock-AgentCore-Runtime-User-Id header (runtimeUserId) is sent.
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:InvokeAgentRuntimeForUser"], resources: [props.chatRuntimeArn, `${props.chatRuntimeArn}/runtime-endpoint/*`] }));
    this.fn = fn;
    this.url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, invokeMode: lambda.InvokeMode.RESPONSE_STREAM });
  }
}
