# Meeting Note Analyzer

Meeting Note Analyzer turns meeting recordings and lecture videos into notes you can review and search. It runs in your AWS account, with a React web app, Cognito login, SageMaker transcription, and analysis on Amazon Bedrock AgentCore.

The app uses the CloudFront URL created during deployment, with HTTPS provided by CloudFront's default certificate. You do not need to register a domain, configure Route 53, provision your own certificate, or set up Google OAuth. Administrators create Cognito accounts; users sign in with their email address and password.

## Features

- **Meeting notes:** upload an MP3 to get a transcript, speaker labels, agenda, detailed notes, follow-up tasks, suggestions, and a mind map.
- **Speaker review:** contextual corrections are checked against transcript evidence. Uncertain changes keep the original speaker and are marked for review. Compare the original and corrected transcripts or play the supporting speech. See [speaker review](docs/speaker-review.md).
- **Meeting editing:** change a meeting title while analysis is running or after it finishes. Title and participant-name edits are coordinated with final document publication so concurrent saves preserve new results.
- **Short meeting brief:** a separate recap of the outcome, decisions and their reasoning, action items, and unresolved questions. Decision explanations include transcript evidence when available.
- **Lecture study:** upload an MP4, optionally with a PPTX or PDF. The pipeline connects screen content with spoken explanations, groups video sections into chapter and topic pages, and generates notes, questions, flashcards, and reference links. Pages in the same chapter share paper recommendations.
- **Lecture recovery:** temporary model-service failures are retried automatically. A retried phase reuses cached scene and page analysis. See [retry behavior](docs/operations.md#lecture-retries).
- **Lecture playback:** a playing lecture docks into a small player when its original position scrolls out of view. Long meeting and lecture titles wrap within the page.
- **Paper search:** lecture references are retrieved through the AgentCore Web Search MCP connector and Gateway.
- **Chat:** ask questions about your meeting and lecture material with source references.
- **Background processing:** once the upload finishes and processing starts, analysis continues on the server after the browser closes. Keep the upload page open until then. Web Push notifications are optional.

The interface is in Korean. Meeting and lecture outputs can be requested in Korean, English, or the source language.

Expired sessions are renewed in the background when a refresh token is available. Drafts and playback remain in place during renewal, and expired audio links can be reconnected without losing the playback position. Recordings with no recognized speech stop before the analysis stages and show a clear error.

## Supported files

| Use | Required input | Optional attachment | Limits |
| --- | --- | --- | --- |
| Meeting | MP3 | None | 500 MiB, up to 4 hours |
| Lecture | MP4 | PPTX or PDF | Video: 4 GiB, up to 4 hours and 4K. Slides: 100 MiB, up to 120 pages. |

For lecture playback, use a browser-compatible MP4 encoding such as H.264/AAC. See [lecture study](docs/lecture-study.md) for screen matching and research limits.

## Architecture

```mermaid
flowchart LR
    User[Browser] --> CF[CloudFront]
    User <--> Auth[Cognito managed login]
    CF --> Site[Private S3 web assets]
    CF --> API[API Gateway and Lambda]
    CF --> Relay[Chat streaming Lambda]
    CF -->|Signed uploads| Files[S3 recordings and results]
    User -->|Signed downloads| Files
    API --> DB[DynamoDB]
    Files -->|Completed MP3 uploads| Events[EventBridge]
    Events --> Workflow[Step Functions]
    API -->|Start or retry processing| Workflow
    Workflow --> STT[SageMaker async STT]
    Workflow --> Agents[AgentCore analysis runtimes]
    Agents --> Bedrock[Bedrock models]
    Agents --> Search[AgentCore Gateway and Web Search]
    Relay --> Chat[AgentCore chat runtime]
    Chat --> Bedrock
    Chat --> KB[AgentCore Gateway and knowledge base]
```

CDK defines separate stacks for storage, authentication, transcription, analysis, lectures, chat, orchestration, API, and web hosting. Local deployment settings and generated AWS identifiers are excluded from Git.

## Prerequisites

- Linux, macOS, or WSL2 with Bash.
- Node.js 22 or newer, Python 3.12 or newer available as `python3`, [uv](https://docs.astral.sh/uv/), and AWS CLI v2.
- Docker with Buildx and support for `linux/amd64` and `linux/arm64` builds.
- AWS credentials allowed to bootstrap CDK and create the resources in this project.
- Bedrock access to the configured Claude models and a SageMaker GPU endpoint quota of at least one instance.
- A Hugging Face read token and access to the transcription and diarization models.

Start with `us-east-1`. Check regional availability for AgentCore Web Search, managed knowledge bases, and the selected models before choosing another region. See [deployment prerequisites](docs/deployment.md#before-you-start) for the service and model requirements.

## Deploy

Deployment creates billable AWS resources, including GPU transcription capacity and model calls. Read the [deployment prerequisites](docs/deployment.md#before-you-start) before starting.

Review the [open dependency advisories](SECURITY.md#known-dependency-advisories) before deployment. Passing tests and secret scans does not resolve those dependency issues.

AWS CLI credentials are used for deployment and administration. They are separate from the Cognito accounts used to sign in to the app.

Choose an existing AWS CLI profile with deployment permissions. If it uses IAM Identity Center, sign in with `aws sso login --profile your-profile` first. For a new SSO profile, use `aws configure sso --profile your-profile`. Other AWS credential methods do not require SSO.

```bash
git clone https://github.com/mateon01/meeting-note-analyzer.git
cd meeting-note-analyzer
npm ci

# Replace your-profile with your configured AWS CLI profile.
export AWS_PROFILE=your-profile

npm run configure -- --email you@example.com
npm run doctor
npm run bootstrap
npm run secrets
npm run deploy
npm run user:create
```

`configure` writes `deploy.local.json`. `secrets` prompts for the Hugging Face token and generates VAPID keys in Secrets Manager. Passwords and tokens are not stored in the project configuration.

The first deployment prepares the STT models in CodeBuild and creates the application. A second CDK pass registers the generated CloudFront address with Cognito and updates the backend configuration. Both passes are handled by `npm run deploy`. CDK displays IAM permission changes for approval. Subsequent deployments reuse the models and saved site URL.

`user:create` prompts for a password and creates the first Cognito account. The deploy command prints the CloudFront address to open.

After deployment, run `npm run check:deployment`, then sign in and upload a short recording. `doctor` checks tools, AWS identity, and model profile discovery; it does not verify GPU quotas or run model inference. The [full deployment guide](docs/deployment.md#6-test-the-installation) covers the application checks.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run diff` | Review infrastructure changes |
| `npm run deploy` | Build and deploy the application |
| `npm run status` | Show current stack outputs |
| `npm run check:deployment` | Check web configuration and Cognito callback URLs |
| `npm run user:create -- --email teammate@example.com` | Create another login |
| `npm run user:password -- --email teammate@example.com` | Set an existing user's password |
| `npm run user:disable -- --email teammate@example.com` | Disable an account and revoke its Cognito sessions |
| `npm run user:enable -- --email teammate@example.com` | Re-enable an account |
| `npm run models:publish` | Republish STT weights; see [model updates](docs/operations.md#model-files-and-instance-changes) before redeploying |
| `npm run dev:config` | Prepare ignored configuration for local frontend development |

Use one checkout per AWS account, region, and installation. The deployment helper records that identity locally and rejects accidental switches. Resource names start with `meeting-analyzer` and stack names with `MeetingAnalyzer` by default; change both before the first deployment if needed.

## Development

Run these commands from the repository root after `npm ci`. The synthesis command uses an example account number for a template check only.

```bash
npm run typecheck
npm test
npm run test:deploy
npm -w web run build
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-1 AWS_EC2_METADATA_DISABLED=true npm run synth

uv sync --project agents --frozen --extra dev
AWS_EC2_METADATA_DISABLED=true uv run --directory agents --extra dev pytest -q
uv sync --project lecture --frozen --extra dev
AWS_EC2_METADATA_DISABLED=true uv run --directory lecture --extra dev pytest -q --require-media
uv sync --project stt --frozen --extra dev
AWS_EC2_METADATA_DISABLED=true uv run --directory stt --extra dev pytest -q
```

Install FFmpeg, including `ffprobe`, to run the video tests and LibreOffice to run the PPTX conversion test. The lecture CI uses `--require-media`: missing media binaries, selecting no media tests, or skipping a media test fails the check. Local runs without this flag can skip video tests when tools are missing. The default STT development environment also skips the PyTorch-dependent diarization test.

For a local frontend connected to your deployed backend:

```bash
npm run dev:config
npm -w web run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the configured CloudFront endpoint. Cognito allows the localhost callback as well as the deployed application URL. Local development still uses your AWS backend and can incur model and transcription charges.

## Repository layout

| Directory | Contents |
| --- | --- |
| `web/` | React PWA |
| `infra/` | CDK stacks |
| `services/api/` | Authenticated application API |
| `services/pipeline/` | Workflow handlers and notifications |
| `agents/` | Meeting analysis and chat runtimes |
| `lecture/` | Video analysis and study material generation |
| `stt/` | SageMaker transcription container |
| `packages/` | Shared contracts and backend helpers |
| `scripts/` | Deployment, operations, model publishing, and source checks |

## Documentation

- [Deployment](docs/deployment.md): first installation and required access
- [Operations](docs/operations.md): updates, users, model changes, costs, and cleanup
- [Meeting briefs](docs/meeting-brief.md): concise summaries and decision evidence
- [Lecture study](docs/lecture-study.md): MP4 input, optional slides, limits, and search
- [Security](SECURITY.md): authentication, data handling, and reporting
- [Dependency notes](docs/dependencies.md): external services, models, and build dependencies
- [Public release review](docs/public-release-review.md): removed deployment details, checks, and validation limits

## Before publishing a fork

Run `npm run check:public` and a [Gitleaks](https://github.com/gitleaks/gitleaks) scan. Keep `deploy.local.json`, `.deployment/`, CDK outputs, local credentials, recordings, and generated notes out of Git. The public CI workflow runs on GitHub-hosted runners and does not deploy to AWS.
