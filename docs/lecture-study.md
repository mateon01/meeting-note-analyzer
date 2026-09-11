# Lecture study

Upload an MP4 lecture video from the upload page. A PPTX or PDF slide deck is optional. The video is the primary input; slides improve the match between the displayed screen and the source page.

The pipeline extracts audio for transcription, samples video frames, and connects visible sections with spoken explanations. Sections confidently matched to an attached slide remain linked to that page. The remaining sections are grouped into chapters and topics using the timestamped speech and visual observations. Each topic becomes a study page with notes, concepts, questions, flashcards, and research references.

The outline aims for topics of two to six minutes instead of making a new study page at every screen change. Long transcripts are outlined in windows of about 45 minutes. Topic pages retain their source video ranges and use up to six representative scene frames as visual evidence. Page counts depend on the lecture and any attached deck.

## Inputs and limits

| Input | Limit |
| --- | --- |
| MP4 video | 4 GiB, 4 hours, up to 4K |
| Optional PPTX/PDF | 100 MiB, 120 pages |
| Sampled video sections | Up to 240 before topic grouping |
| Combined study entries | Up to 360 |

Use a browser-compatible MP4 encoding such as H.264/AAC for playback. The server may be able to decode a video that the browser cannot play. Silent videos can still produce visual notes, but no spoken explanation is available for those sections.

Screen and speech matching is approximate. Review sections marked uncertain or unmatched. Slides not shown in the video and material shown only in the video are kept separate.

## Study material

The lecture view provides:

- An overview, learning objectives, and a suggested review order
- Notes for each video topic or attached slide, with timestamps and source evidence
- Concept explanations, formulas, questions, and flashcards
- A Markdown export and flashcard CSV
- Links back to the relevant video times

The inferred audience and prerequisite knowledge come from the lecture content. Generated explanations and answers should be checked against the lecture and its references.

## Research references

Paper search uses Web Search through an IAM-authenticated AgentCore Gateway. Video topic pages in the same chapter share one set of recommendations, based on up to three search queries for that chapter. Attached slide pages retain their own searches, with up to two queries per page.

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
