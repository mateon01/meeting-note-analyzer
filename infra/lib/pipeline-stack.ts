import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { CONSTRAINTS, STAGES } from "@meeting-notes/shared";
import type { Construct } from "constructs";
import { lambdaErrorsAlarm, notifyOn } from "./alarms.js";
import type { ProjectConfig } from "./config.js";
import { nodeFn } from "./lambda-fn.js";
import { sttNotificationFilter } from "./stt-notification-filter.js";

export interface PipelineStackProps extends StackProps {
  config: ProjectConfig;
  dataBucket: s3.IBucket;
  table: ddb.ITable;
  sttEndpointName: string;
  sttEndpointArn: string;
  sttSuccessTopic: sns.ITopic;
  sttErrorTopic: sns.ITopic;
  agentRuntimeArn: string;
  memoryId: string;
  memoryArn: string;
  alarmTopic: sns.ITopic;
}

/** S3 upload -> EventBridge -> Step Functions: STT -> detailed analysis -> compact recap -> finalize + push. */
export class PipelineStack extends Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config, dataBucket, table } = props;
    const vapidSecret = secrets.Secret.fromSecretNameV2(this, "VapidSecret", config.vapidSecretName);

    const environment = {
      TABLE_NAME: table.tableName,
      DATA_BUCKET: dataBucket.bucketName,
      VAPID_SECRET_NAME: config.vapidSecretName,
      STT_ENDPOINT_NAME: props.sttEndpointName,
      STT_MODE: "intended",
      AGENT_RUNTIME_ARN: props.agentRuntimeArn,
      MEMORY_ID: props.memoryId,
      WEB_ORIGIN: config.siteUrl,
    };
    const fn = (id: string, file: string, timeout = Duration.seconds(60), memorySize = 512) =>
      nodeFn(this, id, { entry: `services/pipeline/src/handlers/${file}.ts`, environment, timeout, memorySize });

    const registerFn = fn("RegisterUploadFn", "register-upload");
    const startSttFn = fn("StartTranscriptionFn", "start-transcription");
    const sttCallbackFn = fn("TranscriptionCallbackFn", "transcription-callback");
    const normalizeFn = fn("NormalizeTranscriptFn", "normalize-transcript", Duration.minutes(5), 1024);
    const invokeAgentFn = fn("InvokeAgentStageFn", "invoke-agent-stage", Duration.minutes(3));
    const finalizeFn = fn("FinalizeFn", "finalize", Duration.minutes(5), 1024);
    const markFailedFn = fn("MarkFailedFn", "mark-failed");

    for (const f of [registerFn, startSttFn, sttCallbackFn, normalizeFn, invokeAgentFn, finalizeFn, markFailedFn]) {
      table.grantReadWriteData(f);
      dataBucket.grantReadWrite(f);
    }
    for (const f of [finalizeFn, markFailedFn]) vapidSecret.grantRead(f);
    startSttFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["sagemaker:InvokeEndpointAsync"], resources: [props.sttEndpointArn] }));
    sttCallbackFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: ["*"] }));
    // Resume mode: these two acknowledge already-completed work by returning the task token themselves.
    for (const f of [startSttFn, invokeAgentFn]) f.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:SendTaskSuccess"], resources: ["*"] }));
    invokeAgentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [props.agentRuntimeArn, `${props.agentRuntimeArn}/runtime-endpoint/DEFAULT`],
      }),
    );
    finalizeFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:CreateEvent"], resources: [props.memoryArn] }));

    sttCallbackFn.addEnvironment("STT_CALLBACK_KIND", "meeting");
    props.sttSuccessTopic.addSubscription(new subs.LambdaSubscription(sttCallbackFn, { filterPolicyWithMessageBody: sttNotificationFilter("meeting") }));
    props.sttErrorTopic.addSubscription(new subs.LambdaSubscription(sttCallbackFn, { filterPolicyWithMessageBody: sttNotificationFilter("meeting") }));

    // ---- state machine (JSONata) ----
    const meetingFields = {
      meetingId: "{% $meeting.meetingId %}",
      ownerSub: "{% $meeting.ownerSub %}",
      title: "{% $meeting.title %}",
      outputLanguage: "{% $meeting.outputLanguage %}",
    };
    // Executions are started either by the S3 "Object Created" event or by the API with { retry: { meetingId } }.
    const resumeField = "{% $exists($meeting.resume) ? $meeting.resume : false %}";
    const briefOnlyField = "{% $exists($meeting.briefOnly) ? $meeting.briefOnly : false %}";
    const transcriptField = "{% $exists($meeting.briefOnly) and $meeting.briefOnly ? $meeting.transcriptKey : $transcript.transcriptKey %}";

    const register = tasks.LambdaInvoke.jsonata(this, "RegisterUpload", {
      lambdaFunction: registerFn,
      payload: sfn.TaskInput.fromObject({
        bucket: "{% $exists($states.input.detail) ? $states.input.detail.bucket.name : null %}",
        key: "{% $exists($states.input.detail) ? $states.input.detail.object.key : null %}",
        size: "{% $exists($states.input.detail) ? $states.input.detail.object.size : null %}",
        retry: "{% $exists($states.input.retry) ? $states.input.retry : null %}",
        executionArn: "{% $states.context.Execution.Id %}",
      }),
      assign: { meeting: "{% $states.result.Payload %}" },
      outputs: "{% $states.result.Payload %}",
    });

    const transcribe = tasks.LambdaInvoke.jsonata(this, "Transcribe", {
      lambdaFunction: startSttFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: "{% $states.context.Task.Token %}",
        meetingId: meetingFields.meetingId,
        ownerSub: meetingFields.ownerSub,
        audioKey: "{% $meeting.audioKey %}",
        languageHint: "{% $exists($meeting.languageHint) ? $meeting.languageHint : null %}",
        resume: resumeField,
        transcriptKey: "{% $exists($meeting.transcriptKey) ? $meeting.transcriptKey : null %}",
      }),
      // Queue wait + processing as SageMaker enforces them, plus slack for the SNS callback to deliver the token.
      taskTimeout: sfn.Timeout.duration(Duration.seconds(CONSTRAINTS.sttQueueTtlSec + CONSTRAINTS.sttInvocationTimeoutSec + 900)),
      assign: { stt: "{% $states.result %}" },
      outputs: "{% $states.result %}",
    });
    // The callback reports endpoint-side transient failures (instance replaced mid-job, "server error (0)") as
    // SttTransient; one automatic re-run replaces the manual retry the user needed on 2026-09-06.
    transcribe.addRetry({ errors: ["SttTransient", "Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"], interval: Duration.seconds(90), maxAttempts: 1 });

    const normalize = tasks.LambdaInvoke.jsonata(this, "NormalizeTranscript", {
      lambdaFunction: normalizeFn,
      payload: sfn.TaskInput.fromObject({
        meetingId: meetingFields.meetingId,
        title: meetingFields.title,
        outputLocation: "{% $exists($stt.outputLocation) ? $stt.outputLocation : null %}",
        skipped: "{% $exists($stt.skipped) ? $stt.skipped : false %}",
        transcriptKey: "{% $exists($stt.transcriptKey) ? $stt.transcriptKey : null %}",
      }),
      assign: { transcript: "{% $states.result.Payload %}" },
      outputs: "{% $states.result.Payload %}",
    });

    const stageTasks = STAGES.map((stage) => {
      const task = tasks.LambdaInvoke.jsonata(this, `Stage_${stage}`, {
        lambdaFunction: invokeAgentFn,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({
          taskToken: "{% $states.context.Task.Token %}",
          stage,
          ...meetingFields,
          transcriptKey: transcriptField,
          documentKey: "{% $exists($meeting.documentKey) ? $meeting.documentKey : null %}",
          executionName: "{% $states.context.Execution.Name %}",
          resume: resumeField,
        }),
        taskTimeout: sfn.Timeout.duration(Duration.seconds(3600)),
        heartbeatTimeout: sfn.Timeout.duration(Duration.seconds(600)),
        outputs: "{% $states.result %}",
      });
      // Retry only errors where the previous attempt is known not to be running (timeouts are deliberately excluded).
      task.addRetry({
        errors: ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException", "AgentTransient"],
        interval: Duration.seconds(30),
        maxAttempts: 2,
        backoffRate: 2,
      });
      return task;
    });

    const finalize = tasks.LambdaInvoke.jsonata(this, "Finalize", {
      lambdaFunction: finalizeFn,
      payload: sfn.TaskInput.fromObject({ ...meetingFields, transcriptKey: transcriptField, briefOnly: briefOnlyField, expectBrief: true }),
      outputs: "{% $states.result.Payload %}",
    });

    // A busy document lock means this attempt has not written anything. Retry without rerunning analysis.
    finalize.addRetry({ errors: ["DocumentBusyError"], interval: Duration.seconds(3), backoffRate: 2, maxAttempts: 15, maxDelay: Duration.seconds(60) });

    const markFailed = tasks.LambdaInvoke.jsonata(this, "MarkFailed", {
      lambdaFunction: markFailedFn,
      payload: sfn.TaskInput.fromObject({ ...meetingFields, errorOutput: "{% $states.input.errorOutput %}" }),
      outputs: "{% $states.result.Payload %}",
    });
    markFailed.next(sfn.Fail.jsonata(this, "Failed", { error: "PipelineFailed", cause: "{% $string($states.input) %}" }));

    let chain: sfn.Chain = sfn.Chain.start(transcribe).next(normalize);
    for (const t of stageTasks) chain = chain.next(t);
    chain = chain.next(finalize);

    const process = sfn.Parallel.jsonata(this, "Process", { outputs: "{% $states.result[0] %}" });
    // Published meetings jump directly to the new recap. No STT, normalization or older stage is invoked.
    process.branch(sfn.Choice.jsonata(this, "AnalysisMode")
      .when(sfn.Condition.jsonata("{% $exists($meeting.briefOnly) and $meeting.briefOnly %}"), stageTasks[STAGES.indexOf("meeting_brief")]!)
      .otherwise(chain));
    process.addCatch(markFailed, { errors: ["States.ALL"], outputs: { errorOutput: "{% $states.errorOutput %}" } });

    const definition = register.next(
      sfn.Choice.jsonata(this, "Proceed?")
        .when(sfn.Condition.jsonata("{% $meeting.proceed = true %}"), process.next(sfn.Succeed.jsonata(this, "Completed")))
        .otherwise(sfn.Succeed.jsonata(this, "Skipped")),
    );

    this.stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: `${config.projectName}-pipeline`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.hours(24), // up to 7 h in STT plus ten agent stages of 1 h each
      tracingEnabled: true,
      logs: { destination: new logs.LogGroup(this, "SfnLogs", { retention: logs.RetentionDays.ONE_MONTH }), level: sfn.LogLevel.ALL, includeExecutionData: false },
    });
    // ---- operator alarms ----
    notifyOn(this, "PipelineFailed", this.stateMachine.metricFailed({ period: Duration.minutes(5), statistic: "Sum" }), props.alarmTopic, "A meeting pipeline execution failed");
    notifyOn(this, "PipelineTimedOut", this.stateMachine.metricTimedOut({ period: Duration.minutes(5), statistic: "Sum" }), props.alarmTopic, "A meeting pipeline execution timed out");
    lambdaErrorsAlarm(this, "SttCallbackErrors", sttCallbackFn, props.alarmTopic, "STT completion callback failed (task token not delivered)");
    lambdaErrorsAlarm(this, "FinalizeErrors", finalizeFn, props.alarmTopic, "Finalize Lambda failed");
    lambdaErrorsAlarm(this, "MarkFailedErrors", markFailedFn, props.alarmTopic, "MarkFailed Lambda failed (meeting may be stuck in a running status)");

    new events.Rule(this, "UploadRule", {
      description: "Start the meeting pipeline when an mp3 lands under uploads/",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: { bucket: { name: [dataBucket.bucketName] }, object: { key: [{ prefix: "uploads/" }] } },
      },
      targets: [new targets.SfnStateMachine(this.stateMachine)],
    });

    new CfnOutput(this, "StateMachineArn", { value: this.stateMachine.stateMachineArn });
  }
}
