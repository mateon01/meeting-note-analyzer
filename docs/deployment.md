# Deployment

This guide installs the application in your AWS account. The deployment uses a CloudFront hostname and Cognito email/password accounts. No custom domain or external identity provider is needed.

## Before you start

Install Node.js 22+, Python 3.12+, uv, AWS CLI v2, and Docker with Buildx. Buildx must support ARM64 for the AgentCore runtimes and AMD64 for the SageMaker GPU image. Docker Desktop usually includes emulation; Linux installations may need binfmt/QEMU configured separately. Check with `docker buildx inspect --bootstrap`.

Prepare the AWS account:

1. Start with `us-east-1`. The application depends on Bedrock, AgentCore Runtime, Memory, Gateway, Web Search, managed knowledge bases, SageMaker async inference, CodeBuild, Lambda, Step Functions, Cognito, S3, DynamoDB, CloudFront, and Secrets Manager.
2. Enable access to the Claude inference profiles listed in `deploy.example.json`. Complete any required model-provider or Marketplace access steps. `doctor` checks profile discovery, which does not prove that model invocations are authorized.
3. Check the SageMaker quota for the configured endpoint instance type. The default is `ml.g5.xlarge` with a scaling maximum of four instances. Available quota must cover the `sttMaxInstances` value you configure.
4. Use an AWS role that can create the listed services, IAM roles and policies, and pass the execution roles to those services. CDK bootstrap also creates an asset bucket and ECR repository. Organizations SCPs can block deployments or cross-region model calls even when a local role allows them.

Prepare Hugging Face access:

- The default transcription model is [CrisperWhisper2.0_large](https://huggingface.co/nyralabs/CrisperWhisper2.0_large).
- Accept the access conditions for [speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) using the account that owns the token.
- The publisher also downloads [wespeaker-voxceleb-resnet34-LM](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM).
- Create a read token with access to those repositories. Do not put the token in a configuration file or a shell command argument.

Model weights are downloaded during setup. They are not included in this Git repository. Review the model providers' licenses and conditions before using another model variant.

## 1. Install and configure

Use an existing AWS CLI profile with deployment permissions. For an IAM Identity Center profile, run `aws sso login --profile your-profile` first; configure a new SSO profile with `aws configure sso --profile your-profile` if needed. SSO is not required when you use another AWS credential method. These credentials manage AWS resources, while app users sign in with separate Cognito accounts.

```bash
npm ci
export AWS_PROFILE=your-profile
npm run configure -- --email you@example.com
```

The configuration command creates an ignored, mode-0600 `deploy.local.json` file. Review it before deploying. Important settings are:

| Setting | Default | Purpose |
| --- | --- | --- |
| `projectName` | `meeting-analyzer` | Resource names and secret prefix |
| `stackPrefix` | `MeetingAnalyzer` | CloudFormation stack names |
| `region` | `us-east-1` | Deployment region |
| `operatorEmail` | Set during configure | VAPID contact and default first user |
| `siteUrl` | Empty initially | Filled from the CloudFront stack output |
| `cognitoDomainPrefix` | Generated | Cognito managed-login domain, unique per account and region |
| `sttMinInstances` | `0` | Idle transcription capacity |
| `sttMaxInstances` | `4` | Maximum transcription capacity |
| `sttDeployEndpoint` | `false` initially | Enabled by the deploy command after model files are ready |
| `opusModel`, `sonnetModel`, `haikuModel` | See example file | Bedrock inference profile IDs |
| `enableSlackAlarms` | `false` | Optional Slack alarm forwarder |
| `lectureMaxModelCalls`, `lectureMaxSearchCalls` | `800`, `240` | Per-attempt lecture call limits |
| `stageBudgetUsd` | `50` | Estimated SDK budget per meeting analysis stage |

Choose the project and stack names before the first installation. Existing data resources use retention policies, so renaming an installation is not an in-place migration.

## 2. Check tools and bootstrap

```bash
npm run doctor
npm run bootstrap
```

`doctor` checks tools, the Docker daemon, AWS identity, and model profile discovery. For a local tool check without AWS calls, use `npm run doctor -- --offline`.

The helper records the target account, region, and project in `.deployment/state.json`. That directory is ignored by Git. Use a separate checkout to deploy another installation.

Bootstrap is normally needed once per account and region. It prepares the CDK resources used to publish Lambda bundles and container images.

## 3. Store setup secrets

```bash
npm run secrets
```

The command asks for the Hugging Face token and generates VAPID keys. It creates these Secrets Manager entries:

- `<projectName>/hf-token`
- `<projectName>/vapid`

Existing values are kept. To replace an expired Hugging Face token, update that secret in the AWS console. Keep existing VAPID keys unless you intend to register browser push subscriptions again.

The helper passes secret values to AWS CLI through temporary files with mode 0600, then removes them. Secrets are not printed or added to Git.

## 4. Deploy

```bash
npm run deploy
```

The first run performs these steps:

1. Builds the web application.
2. Deploys the Data stack and the STT model publisher without a SageMaker endpoint.
3. Starts the CodeBuild model publisher if model files are missing. This downloads the transcription and diarization weights, converts the transcription model, and uploads the result to S3.
4. Enables the SageMaker endpoint in the local configuration and deploys the application stacks.
5. Reads the generated CloudFront URL, saves it locally, and reapplies the configuration to Cognito, CORS, uploads, chat, and notifications.
6. Checks the published web configuration and Cognito callback/logout URLs.

CDK prints permission changes and may ask for IAM approval. The model download and first image builds can take a substantial amount of time; CodeBuild and SageMaker progress can be inspected in their AWS consoles.

The URL configuration requires two CDK passes because Cognito needs an exact callback URL while CloudFront assigns its hostname during deployment. The helper handles both passes. If a run stops between them, run `npm run deploy` again.

The successful command prints a URL such as `https://dexample.cloudfront.net`. The example hostname is not a running service; use the value printed by your deployment.

## 5. Create a login

```bash
npm run user:create
# Additional users:
npm run user:create -- --email teammate@example.com
```

Choose a password with at least 12 characters, including uppercase, lowercase, a number, and a symbol. The command creates a Cognito account and sets its password. It does not send an invitation email. Provide the credentials to the intended user through your usual secure channel.

Open the CloudFront URL, choose the login button, and enter the email and password on Cognito's managed login page. Public self-sign-up is disabled.

For an existing account:

```bash
npm run user:password -- --email teammate@example.com
```

## 6. Test the installation

```bash
npm run check:deployment
```

Then test the application:

1. Sign in and confirm the browser returns to the CloudFront site.
2. Upload a short MP3. Check the transcript, detailed notes, and concise brief after processing finishes.
   In the transcript tab, compare the original and corrected speakers and inspect any **검토 필요** markers. See [speaker review](speaker-review.md#updating-and-checking-an-installation) for the checks.
3. Upload a short MP4 with visible slides and speech. Check the screen sections, evidence, study questions, and exports.
4. Open a chat and follow a source reference back to its meeting or lecture.
5. Enable completion notifications if your browser supports Web Push.
6. Delete the test material when finished.

The STT endpoint can scale to zero. A first request after an idle period waits for an instance and model to start; it will take longer than a request handled by an already running instance.

For lecture search discovery:

```bash
uv run --project lecture python scripts/dev/check-lecture-gateway.py \
  --stack MeetingAnalyzer-Lecture --region us-east-1
```

Use your configured stack prefix and region. Add `--search` to perform one test search. The check invokes the lecture runtime and can incur service charges. Discovery alone does not call a language model.

## Updating an installation

```bash
git pull --ff-only
npm ci
npm run diff
npm run deploy
```

The deploy command reuses model files and retains the saved CloudFront URL. See [operations](operations.md) before changing models, instance types, capacity, or resource names.
