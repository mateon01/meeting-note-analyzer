# Lecture study

Select **영상 MP4** or **음성 MP3** in the lecture upload form. A PPTX or PDF slide deck is optional for either format. Upload one recording per lecture.

**분석할 페이지 (선택)** accepts inclusive ranges such as `38-47` or `3-8, 12-15`. Only those physical pages are rendered and read by the model. This field takes precedence over **추가 요청 (선택)**, which accepts up to 2,000 characters. When the page field is blank, a request such as “38–47페이지 위주” or “18페이지까지” also sets a hard selection. An out-of-range request fails before slide analysis instead of widening to the whole deck. With no page restriction, the entire deck is available. Page numbers refer to the attached file's physical order, starting at 1.

The selected pages become topic groups, usually spanning two to six connected slides. An overview or repeated material gets brief coverage; a substantive derivation gets more detail. The study call, questions, flashcards and paper search run once per group. The interface and exports show the original page ranges, and the group view lets the reader switch between its source images. Caches include the selection, group plan and study prompt version, so an old whole-deck result cannot leak into a selected-range result. Retrying reuses the original transcript and applicable slide readings and speech links.

For MP3 or MP4 with slides, the study follows the selected deck pages and links recorded speech by conceptual evidence. These semantic links do not claim that a slide was visibly displayed in the video. For MP3 alone, the pipeline organizes the transcript into chapters and topics, preserving timestamps for audio playback. Audio-only notes do not claim to have seen slides or diagrams. The prepare step probes the actual MP3 format and duration; a renamed non-MP3 file is rejected.

For MP4 without an attached deck, the pipeline extracts audio for transcription, samples actual video frames, and connects visible sections with spoken explanations. It groups them into chapters and topics using timestamped speech and visual observations, retaining board work and demonstrations. Each topic becomes a study entry with notes, concepts, questions, flashcards, and research references.

The outline aims for topics of two to six minutes instead of making a new study page at every screen change. Long transcripts are outlined in windows of about 45 minutes. Topic pages retain their source video ranges and use up to six representative scene frames as visual evidence. Page counts depend on the lecture and any attached deck.

## Inputs and limits

| Input | Limit |
| --- | --- |
| MP4 video | 4 GiB, 4 hours, up to 4K |
| MP3 audio | 500 MiB, 4 hours |
| Optional PPTX/PDF | 100 MiB, 120 pages |
| Sampled video sections | Up to 240 before topic grouping |
| Combined study entries | Up to 360 |

Use a browser-compatible MP4 encoding such as H.264/AAC for playback. The server may be able to decode a video that the browser cannot play. Silent videos can still produce visual notes, but no spoken explanation is available for those sections.

Screen and speech matching is approximate. Review sections marked uncertain or unmatched.

## Study material

The lecture view provides:

- An overview, learning objectives, and a suggested review order
- Notes for each video topic or selected slide group, with timestamps and source evidence
- Concept explanations, formulas, questions, and flashcards
- A Markdown export, flashcard CSV, and PDF through browser printing
- A transcript tab with TXT and Markdown downloads of the full original STT transcript
- Links back to the relevant video or audio times

The inferred audience and prerequisite knowledge come from the lecture content. Generated explanations and answers should be checked against the lecture and its references.

Theory explanations start with the idea in plain language, its purpose, and the prerequisites before introducing formal notation. Mathematical notes retain the original statement, explain symbols and assumptions, and provide a justified derivation and a concrete example. Bounded excerpts of the selected deck pages supply context for earlier definitions. References may point only to supplied pages.

The model checks sign conventions, derivatives, dimensions, and assumptions against that context. A demonstrated inconsistency is shown as **원본 오류 수정**, with the original and corrected formulas kept separately; incomplete or ambiguous evidence is shown as **원본 확인 필요**. This is model-assisted review, not formal mathematical verification.

Existing documents stay readable. **학습 설명 업데이트** reruns a completed lecture with the current study prompt, reusing its transcription, slide readings, and successful research. Prompt version changes invalidate both attached-slide and video-topic study caches. Model calls during regeneration may incur costs.

## PDF and access

Choose **PDF로 저장** on the lecture page, then select **Save as PDF** in the browser print dialog. The print layout includes every study section, formulas rendered with KaTeX, source filenames and page references, explanations, review answers, flashcards, evidence, and paper links. It uses text and equations; download the original slide deck separately if you need its images.

PDF preparation happens in the browser. It does not upload a copy to another service or create a public share URL. Signed URLs for recordings, slide images, and private downloads are excluded from the print content. All lecture API routes retain login and owner checks. The saved PDF can be shared as a file.

The **전사** tab offers **TXT 다운로드** and **Markdown 다운로드**, including all segments, timestamps, and speaker IDs. Lectures currently produce an original transcript only. Meeting transcripts additionally offer the existing speaker-corrected version: select **보정 전사** or **원본 전사** before downloading. Review filters do not shorten the exported file, and pending speaker proposals remain marked as unapproved.

## Research references

Paper search uses Web Search through an IAM-authenticated AgentCore Gateway. Video topics in the same chapter share one set of recommendations, based on up to three search queries. A selected slide group has up to two queries and one shared set of recommendations.

The final result contains up to three papers, with source titles and URLs copied from the search results. If the model proposes extra candidates or overly long guidance within the accepted response limits, the selector keeps the first three choices and limits each explanation to 800 characters. Each retained choice must reference an existing, distinct search result.

Search can fail independently of study generation. The interface distinguishes a failed search from a search with no matching papers. A retry can reuse completed processing.

After deployment, check the gateway with:

```bash
uv run --project lecture python scripts/dev/check-lecture-gateway.py \
  --stack MeetingAnalyzer-Lecture --region us-east-1
```

Add `--search` to perform one fixed test query. Use your own stack prefix and region. This runs in the lecture runtime role and checks the actual connector, rather than assuming a synthesized configuration proves service availability.

## Processing and costs

Lectures share the SageMaker transcription endpoint with meetings. An endpoint scaled to zero takes time to start. Temporary model-service failures are retried automatically, with cached scene and page analysis reused on the next attempt. Invalid inputs and permission errors still require attention. See [lecture retries](operations.md#lecture-retries) for the waiting intervals and failure handling.

Model and search limits apply to one runtime attempt. Automatic phase retries and manual retries start new bounded attempts, so a lecture's total calls can exceed a single attempt's limit. Long videos, many visible sections, and repeated retries increase cost.

Page work uses four worker threads by default. Reading slides, observing and matching scenes, generating notes, and researching page groups can run concurrently, while results retain their original order. Model-call and token counters are protected across workers, and search calls share the configured request limit.

See [deployment](deployment.md) for setup and [operations](operations.md) for monitoring and resource management.

## Chat

The chat source picker offers **회의록·전사**, **강의**, and **전체**. Choose all your lectures or one completed lecture; **이 강의에 질문하기** on a lecture opens a conversation pinned to that lecture. Changing the source starts a new conversation, so its history does not mix with another source. Session scope and ownership are enforced in both search filters and direct document tools. Lecture tools read the current published document and its group-to-slide mapping, and search discards superseded runs while the knowledge base catches up.

Chat renders inline and displayed LaTeX while retaining clickable evidence references. The lecture tool accepts an omitted page for the outline and a physical `sourcePage` for the group containing that slide. Runtime deployments start a new container revision for subsequent turns while retaining the conversation's stored history.

## Guest sharing

Choose **게스트 공유** from the lecture list or the detail page's action row, enter up to 20 allowed email addresses, and choose an expiry of 7, 30 or 90 days. Creating the link does not send mail. Send the link to the intended readers; they request an email code on the shared page and enter the complete code within five minutes. Eight-character Cognito codes and six-character codes are accepted for provider verification. Guests do not enter a password.

A separate Cognito Essentials pool sends and verifies email OTPs using Cognito's default email delivery. The app client has a secret held on the server, and public self-signup is disabled. Code requests are rate limited; a challenge allows five attempts and can be used once. The verified ID token is kept in a Secure, HttpOnly, SameSite cookie for one hour. Cognito's default email sending quotas apply.

When an initial token predates the email-verification update, the server reads the current Cognito user and requires a confirmed, enabled account with the same signed subject, the same email, and a verified email attribute. The application never changes verification attributes to grant access.

Guests can read the shared lecture's published study notes and images and save the notes as PDF. They do not receive access to owner APIs, chat, original recording downloads or the full transcript. Every document and image request checks the current email allowlist, expiry, revocation and lecture ownership. Private responses are not cached; images use authenticated proxy URLs rather than bearer download links. **공유 해제** prevents subsequent reads, including image requests. Copies a reader already saved remain outside the app's control.

Lecture sharing records and short-lived verification/rate-limit records use the lecture table's TTL field. Expiry is also checked in application code, independently of asynchronous TTL deletion. Existing owner sign-in configuration is unchanged.
