# Lecture study

Upload an MP4 lecture video from the upload page. A PPTX or PDF slide deck is optional. The video is the primary input; slides improve the match between the displayed screen and the source page.

The pipeline extracts audio for transcription, samples video frames, groups visible sections, and connects those sections with spoken explanations. It then creates an overview, section notes, concepts, questions, flashcards, and research references.

## Inputs and limits

| Input | Limit |
| --- | --- |
| MP4 video | 4 GiB, 4 hours, up to 4K |
| Optional PPTX/PDF | 100 MiB, 120 pages |
| Grouped video sections | Up to 240 |
| Combined study entries | Up to 360 |

Use a browser-compatible MP4 encoding such as H.264/AAC for playback. The server may be able to decode a video that the browser cannot play. Silent videos can still produce visual notes, but no spoken explanation is available for those sections.

Screen and speech matching is approximate. Review sections marked uncertain or unmatched. Slides not shown in the video and material shown only in the video are kept separate.

## Study material

The lecture view provides:

- An overview, learning objectives, and a suggested review order
- Notes for each screen section or slide, with timestamps and source evidence
- Concept explanations, formulas, questions, and flashcards
- A Markdown export and flashcard CSV
- Links back to the relevant video times

The inferred audience and prerequisite knowledge come from the lecture content. Generated explanations and answers should be checked against the lecture and its references.

## Research references

Paper search uses Web Search through an IAM-authenticated AgentCore Gateway. Results are selected for relevance to a section and include source links and a reading focus.

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

See [deployment](deployment.md) for setup and [operations](operations.md) for monitoring and resource management.
