# Operations

Run deployment commands from the repository root with the same AWS profile and `deploy.local.json` used for installation. `npm run status` prints stack outputs, including the site URL, user pool, workflows, knowledge base, and model publisher.

## Application updates

```bash
git pull --ff-only
npm ci
npm run diff
npm run deploy
```

Review replacements in the diff before deploying. A change to a stack or construct name can replace a resource rather than update it. Keep resource names stable after installation.

The deploy helper uses the existing CloudFront address and model files. If the first deployment stopped before URL configuration finished, rerunning it completes that step.

## Accounts

Public sign-up is disabled. AWS administrators manage users through the helper or the Cognito console.

```bash
npm run user:create -- --email teammate@example.com
npm run user:password -- --email teammate@example.com
npm run user:disable -- --email teammate@example.com --dry-run
npm run user:disable -- --email teammate@example.com
npm run user:enable -- --email teammate@example.com
```

The disable and enable commands require an explicit `--email` and use the user pool in this installation. Add `--dry-run` to either command to check the current account and preview the change. These commands do not send an email.

Disabling an account blocks new sign-ins and revokes its tokens in Cognito. Enabling it allows the user to sign in again; previously revoked tokens remain revoked. See [Cognito token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html).

API Gateway validates JWT signatures and expiration without consulting Cognito's revocation state. An already issued ID token can therefore remain usable at the API until it expires, up to four hours with this application's settings. Account suspension is not an immediate API access cutoff.

Use the Cognito console to delete an account. Disabling or deleting a Cognito account does not delete that user's recordings, notes, or chat history. Remove application data separately when required.

The password command sets a new permanent password. It does not send an invitation email. Cognito's managed login also provides password recovery through the account's email address.

Logging out from Settings first attempts to revoke the current session's refresh token, then clears the local session and opens Cognito's logout endpoint. If revocation fails, local logout still completes, but a copy of that refresh token can remain usable. Tokens already accepted by API Gateway have the expiration limit described above.

## Model files and instance changes

Model files live under `models/stt/<variant>/` in the application data bucket. SageMaker loads that prefix when an instance starts.

To publish new files:

```bash
npm run models:publish
```

After replacing files in an existing prefix, increment `sttModelRevision` in `deploy.local.json`, review the diff, and deploy. The revision causes SageMaker to load the updated model artifacts.

Changing the instance type requires care when Application Auto Scaling is registered:

1. Set `sttAutoscaling` to `false`, keeping the current instance type, and deploy the STT stack.
2. Change `sttInstanceType`, review the diff, and deploy the STT stack.
3. Set `sttAutoscaling` to `true` and deploy again.

For the default stack name, each STT-only deployment is:

```bash
npm -w infra run cdk -- diff MeetingAnalyzer-Stt
npm -w infra run cdk -- deploy MeetingAnalyzer-Stt
```

Use your own stack prefix. Keep `sttDeployEndpoint=true` on an installed application. The `deploy:foundation` command refuses to run when an endpoint already exists so it cannot remove a running endpoint by applying the initial setup configuration.

## Costs and capacity

The main cost sources are:

- SageMaker GPU instance time for transcription
- Bedrock model calls for analysis, brief generation, study material, and chat
- AgentCore Runtime, Memory, Gateway, and Web Search
- Knowledge-base storage, indexing, and retrieval
- S3 storage and requests, CloudFront transfer, CodeBuild, Lambda, and logs

`sttMinInstances=0` allows the transcription endpoint to scale down while idle. This does not make the entire application free. The next transcription request waits for capacity and model loading. Set a nonzero minimum only when the faster start is worth the idle instance cost.

New installations use `sttMaxInstances=4`. Existing `deploy.local.json` values take precedence, so pulling an update does not overwrite a saved capacity limit. Review the instance quota and capacity setting before raising it.

Meeting and lecture transcription requests can wait in the shared SageMaker queue for up to six hours, followed by up to one hour of processing. The workflow allows another 15 minutes for the callback. Both workflows have a 24-hour overall limit. A longer queue wait does not increase the four-hour input-duration limit or guarantee that a request will finish. These settings follow the [SageMaker async request limits](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_runtime_InvokeEndpointAsync.html).

`lectureMaxModelCalls` and `lectureMaxSearchCalls` set the per-attempt limits for lecture model and search calls. Their defaults are 800 and 240. `stageBudgetUsd` sets the meeting SDK budget per analysis stage; its default is 50. The SDK budget is an estimate, not an AWS billing cap. These counters are not monthly budgets or dollar limits, and explicit retries start another attempt. Long videos and many slide sections cost more than short examples. Check AWS billing and service metrics after testing with representative files.

See current [SageMaker pricing](https://aws.amazon.com/sagemaker/ai/pricing/), [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/), and [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/). Global inference profiles can route requests to other regions; select an appropriate profile if region boundaries matter for your data.

## Storage lifecycle

The Data stack applies these rules to the application bucket:

| Prefix | Lifecycle |
| --- | --- |
| `uploads/` | Transition recordings to S3 Intelligent-Tiering with a zero-day rule |
| `lecture-uploads/` | Apply the same rule to lecture videos and optional slide decks |
| `lecture-results/` | Apply the same rule to rendered pages and study results |
| `stt/` | Expire temporary transcription files after 30 days |
| `results/`, `transcripts/`, `models/` | Keep meeting results, normalized transcripts, and model files in S3 Standard |

S3 evaluates the zero-day transition after creation; it is not an immediate upload-time storage-class change. Objects smaller than 128 KB are excluded by S3's default lifecycle behavior. See [Intelligent-Tiering lifecycle rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-intelligent-tiering.html) and [transition constraints](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html).

Optional Archive Access and Deep Archive Access tiers are not enabled. Incomplete multipart uploads are aborted after two days. Retained recordings and results have no automatic expiration rule.

## Monitoring

Use Step Functions to inspect meeting and lecture execution history. Each stage records its status, and completed stages are reused during supported retries. CloudWatch contains Lambda, SageMaker, CodeBuild, and AgentCore runtime logs.

The Data stack creates an SNS topic for operational alarms. Set `alarmEmail` locally to subscribe an operator address, then confirm the subscription email.

Slack is optional:

1. Set `enableSlackAlarms=true` and deploy.
2. Run `npm run secrets -- --slack` and enter an incoming webhook URL.

The setup command stores the webhook and does not send a test message. Do not put webhook URLs in issues or logs.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Cognito reports `redirect_mismatch` | Run `npm run deploy` again, then `npm run check:deployment`. The exact CloudFront callback URL must be registered. |
| Account cannot sign in | Confirm it exists in the correct user pool, is enabled, and has a permanent password. |
| Model publisher fails | Check the CodeBuild log, token access, accepted Hugging Face conditions, and outbound download access. |
| SageMaker creation fails | Check endpoint quotas, instance availability, image architecture, model files, and execution-role permissions. |
| Transcription appears idle | Check Step Functions and the async queue. Capacity may be starting from zero. |
| Bedrock calls fail | Check provider access, profile availability, quotas, execution-role permissions, and SCPs. |
| Paper search fails | Run the lecture Gateway check. Study material can be available even when search fails. |
| Chat has no sources | Confirm knowledge-base ingestion has completed. Indexing runs separately from note generation. |
| Local frontend shows a configuration error | Run `npm run dev:config` and restart Vite. |

## Removing an installation

```bash
npm run destroy -- --confirm-project meeting-analyzer
```

Use the exact `projectName` from your local configuration. The command deletes the application stacks. Data buckets, DynamoDB tables, the Cognito user pool, and setup secrets are retained. Retained resources can continue to incur charges.

Inspect retained resources in the AWS console before removing them. Export anything you need, then delete data, backups, secrets, and the retained user pool explicitly. The user pool has deletion protection. CDK bootstrap resources and old deployment assets are shared infrastructure and need a separate cleanup decision.

Do not treat stack deletion as a complete data-erasure operation. Knowledge-base contents, AgentCore Memory records, application data, backups, and logs have separate lifecycles.
