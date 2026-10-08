import { Duration } from "aws-cdk-lib";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type * as sns from "aws-cdk-lib/aws-sns";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { CONSTRAINTS } from "@meeting-notes/shared";
import type { ProjectConfig } from "./config.js";
import { nodeFn } from "./lambda-fn.js";
import { notifyOn } from "./alarms.js";

interface Props {
  config: ProjectConfig; dataBucket: s3.IBucket; table: ddb.ITable; pushTable: ddb.ITable;
  runtimeArn: string; sttEndpointName: string; sttEndpointArn: string; alarmTopic: sns.ITopic;
}

/** Isolated interview data/workflow; shares the existing transcription endpoint and bounded analysis runtime. */
export class InterviewService extends Construct {
  readonly apiFunction: lambda.IFunction;
  readonly stateMachine: sfn.StateMachine;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);
    const environment = {
      TABLE_NAME: props.table.tableName, INTERVIEW_TABLE_NAME: props.table.tableName,
      DATA_BUCKET: props.dataBucket.bucketName, LECTURE_RUNTIME_ARN: props.runtimeArn,
      STT_ENDPOINT_NAME: props.sttEndpointName, STT_MODE: "intended", WEB_ORIGIN: props.config.siteUrl,
      VAPID_SECRET_NAME: props.config.vapidSecretName,
    };
    const processor = nodeFn(this, "Processor", { entry: "services/pipeline/src/handlers/interview.ts", environment, timeout: Duration.minutes(3), memorySize: 1024 });
    const complete = nodeFn(this, "Complete", { entry: "services/pipeline/src/handlers/interview.ts", environment: { ...environment, TABLE_NAME: props.pushTable.tableName }, timeout: Duration.minutes(2) });
    for (const fn of [processor, complete]) props.table.grantReadWriteData(fn);
    for (const prefix of ["interview-uploads/*", "interview-results/*", "stt/*"]) props.dataBucket.grantReadWrite(processor, prefix);
    props.dataBucket.grantReadWrite(complete, "interview-results/*");
    props.pushTable.grantReadWriteData(complete);
    secrets.Secret.fromSecretNameV2(this, "Vapid", props.config.vapidSecretName).grantRead(complete);
    processor.addToRolePolicy(new iam.PolicyStatement({ actions: ["sagemaker:InvokeEndpointAsync"], resources: [props.sttEndpointArn] }));
    processor.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeAgentRuntime"], resources: [props.runtimeArn, `${props.runtimeArn}/runtime-endpoint/DEFAULT`] }));
    processor.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:SendTaskSuccess"], resources: ["*"] }));
    const fields = { interviewId: "{% $job.interviewId %}", runId: "{% $job.runId %}" };
    const initialize = sfn.Pass.jsonata(this, "Input", { assign: { job: "{% $states.input %}" } });
    const register = tasks.LambdaInvoke.jsonata(this, "Register", { lambdaFunction: processor, payload: sfn.TaskInput.fromObject({ op: "register", ...fields }) });
    const runtimeTask = (phase: "prepare" | "analyze") => {
      const task = tasks.LambdaInvoke.jsonata(this, phase === "prepare" ? "PrepareAudio" : "AnalyzeInterview", {
        lambdaFunction: processor, integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({ op: phase, ...fields, taskToken: "{% $states.context.Task.Token %}", attempt: "{% $states.context.State.RetryCount %}" }),
        ...(phase === "analyze" ? { assign: { result: "{% $states.result %}" } } : {}),
        taskTimeout: sfn.Timeout.duration(Duration.hours(phase === "prepare" ? 1 : 8)), heartbeatTimeout: sfn.Timeout.duration(Duration.minutes(10)),
      });
      task.addRetry({ errors: ["LectureTransient"], interval: Duration.minutes(3), backoffRate: 2, maxAttempts: 2 });
      return task;
    };
    const transcribe = tasks.LambdaInvoke.jsonata(this, "Transcribe", {
      lambdaFunction: processor, integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ op: "transcribe", ...fields, taskToken: "{% $states.context.Task.Token %}" }),
      assign: { stt: "{% $states.result %}" }, taskTimeout: sfn.Timeout.duration(Duration.seconds(CONSTRAINTS.sttQueueTtlSec + CONSTRAINTS.sttInvocationTimeoutSec + 900)),
    });
    transcribe.addRetry({ errors: ["SttTransient"], interval: Duration.seconds(90), maxAttempts: 1 });
    const normalize = tasks.LambdaInvoke.jsonata(this, "Normalize", { lambdaFunction: processor, payload: sfn.TaskInput.fromObject({ op: "normalize", ...fields, stt: "{% $stt %}" }) });
    const publish = tasks.LambdaInvoke.jsonata(this, "Publish", { lambdaFunction: complete, payload: sfn.TaskInput.fromObject({ op: "complete", ...fields, result: "{% $result %}" }) });
    const failed = tasks.LambdaInvoke.jsonata(this, "MarkFailed", { lambdaFunction: processor, payload: sfn.TaskInput.fromObject({ op: "failed", ...fields, error: "{% $states.input.error %}" }) });
    failed.next(sfn.Fail.jsonata(this, "InterviewFailed"));
    const process = sfn.Parallel.jsonata(this, "Process");
    process.branch(register.next(runtimeTask("prepare")).next(transcribe).next(normalize).next(runtimeTask("analyze")).next(publish));
    process.addCatch(failed, { outputs: { error: "{% $states.errorOutput %}" } });
    const machine = this.stateMachine = new sfn.StateMachine(this, "Pipeline", {
      stateMachineName: `${props.config.projectName}-interview-pipeline`, queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(initialize.next(process)), timeout: Duration.hours(24), tracingEnabled: true,
      logs: { destination: new logs.LogGroup(this, "PipelineLogs", { retention: logs.RetentionDays.ONE_MONTH }), level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });
    notifyOn(this, "FailedAlarm", machine.metricFailed(), props.alarmTopic, "Interview processing failed");
    notifyOn(this, "TimeoutAlarm", machine.metricTimedOut(), props.alarmTopic, "Interview processing timed out");
    const api = nodeFn(this, "Api", {
      entry: "services/api/src/handlers/interviews.ts", timeout: Duration.seconds(29), memorySize: 1024,
      environment: { INTERVIEW_TABLE_NAME: props.table.tableName, DATA_BUCKET: props.dataBucket.bucketName,
        UPLOAD_BASE_URL: props.config.siteUrl, INTERVIEW_STATE_MACHINE_ARN: machine.stateMachineArn },
    });
    props.table.grantReadWriteData(api);
    for (const prefix of ["interview-uploads/*", "interview-results/*"]) props.dataBucket.grantReadWrite(api, prefix);
    machine.grantStartExecution(api);
    this.apiFunction = api;
  }
}
