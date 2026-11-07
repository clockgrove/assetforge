# Gateway models

What the Vercel AI Gateway served on **2026-11-07**, read from its public model list (`GET https://ai-gateway.vercel.sh/v1/models`, no key needed). The list changes often; rerun the query before changing a default route. Prices are as the list reported them; Assetforge records each call's actual cost when the gateway reports one.

The gateway listed 498 models: 320 language, 39 image, 37 video, 28 embedding, 24 speech, 16 transcription, 15 evaluation, 10 realtime and 9 reranking.

## Image models (39)

`bfl/flux-2-flex`, `bfl/flux-2-klein-4b`, `bfl/flux-2-klein-9b`, `bfl/flux-2-max`, `bfl/flux-2-pro`, `bfl/flux-3-image`, `bfl/flux-3-image-klein`, `bfl/flux-kontext-max`, `bfl/flux-kontext-pro`, `bfl/flux-pro-1.0-fill`, `bfl/flux-pro-1.1`, `bfl/flux-pro-1.1-ultra`, `bytedance/seedream-4.0`, `bytedance/seedream-4.5`, `bytedance/seedream-5.0-lite`, `bytedance/seedream-5.0-pro`, `meta/muse-image-1.0`, `microsoft/mai-image-2.6`, `microsoft/mai-image-2.6-flash`, `openai/gpt-image-1-mini`, `openai/gpt-image-1.5`, `openai/gpt-image-2`, `openai/gpt-image-2.5-flare`, `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2.6-flare`, `openai/gpt-image-2.6-sunburst`, `prodia/flux-fast-schnell`, `recraft/recraft-v2`, `recraft/recraft-v3`, `recraft/recraft-v4`, `recraft/recraft-v4-pro`, `recraft/recraft-v4.1`, `recraft/recraft-v4.1-flash`, `recraft/recraft-v4.1-pro`, `recraft/recraft-v4.1-utility`, `recraft/recraft-v4.1-utility-pro`, `topaz/wonder-3.5`, `spacexai/grok-imagine-image`, `spacexai/grok-imagine-image-2.0`.

Language models that also output images (reachable through text generation, not the image API): `google/gemini-2.5-flash-image`, `google/gemini-3-pro-image`, `google/gemini-3.1-flash-image`, `google/gemini-3.1-flash-lite-image`, `google/gemini-nano-banana-2.1`, `quiverai/arrow-2`, `quiverai/arrow-2-telos`.

## Video models (37)

`alibaba/wan-v2.5-t2v-preview`, `alibaba/wan-v2.6-i2v`, `alibaba/wan-v2.6-i2v-flash`, `alibaba/wan-v2.6-r2v`, `alibaba/wan-v2.6-r2v-flash`, `alibaba/wan-v2.6-t2v`, `alibaba/wan-v2.7-r2v`, `alibaba/wan-v2.7-t2v`, `alibaba/wan-v3.0-video`, `alibaba/wan-v3.0-video-prime`, `bfl/flux-3-video`, `bytedance/seedance-2.0`, `bytedance/seedance-2.0-fast`, `bytedance/seedance-2.0-mini`, `bytedance/seedance-2.5`, `bytedance/seedance-v1.0-pro`, `bytedance/seedance-v1.0-pro-fast`, `bytedance/seedance-v1.5-pro`, `google/veo-3.1-fast-generate-001`, `google/veo-3.1-generate-001`, `google/veo-3.1-lite-generate-001`, `heygen/heygen-video-1`, `klingai/kling-v2.5-turbo-i2v`, `klingai/kling-v2.5-turbo-t2v`, `klingai/kling-v2.6-i2v`, `klingai/kling-v2.6-motion-control`, `klingai/kling-v2.6-t2v`, `klingai/kling-v3.0-i2v`, `klingai/kling-v3.0-motion-control`, `klingai/kling-v3.0-t2v`, `minimax/minimax-h3`, `minimax/minimax-h3-max`, `topaz/proteus`, `topaz/starlight-precise-2.6`, `spacexai/grok-imagine-video`, `spacexai/grok-imagine-video-1.5`, `spacexai/grok-imagine-video-1.5-lite`.

Video is not used yet: animation is generated as a whole contact sheet first (owner decision, 2026-11-07), with video-to-frames later.

## Default routes

Set in `src/routes.ts` and overridable with `--routes <file.json>` (a JSON object of operation → partial route).

| Operation                      | Model                   | Why                                                                                                                   | Estimate per call                                |
| ------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `still` (stills and key poses) | `openai/gpt-image-2`    | The issue makes GPT-image the default for stills; it takes reference images. Token-priced ($5/M input, $30/M output). | $0.25 (upper bound at 1024x1024 with references) |
| `edit` (each animation frame)  | `bfl/flux-kontext-pro`  | A reference-edit model: it edits the key pose it is given. Flat $0.04 per image. Accepts a seed.                      | $0.05                                            |
| `vision` (QA)                  | `google/gemini-3-flash` | A cheap vision-capable language model.                                                                                | $0.02                                            |
| `sheet` (a cycle as one sheet) | `openai/gpt-image-2`    | Whole-sheet generation keeps identity across frames (owner decision); it takes references. Requested at 1536x1024.    | $0.30 (upper bound at 1536x1024 with references) |

A 6-frame strip edits its author-approved key pose 6 times and makes one QA call: about $0.32 per candidate, so the default 4 candidates reserve about $1.28 of the $5 cap. The key pose comes from an earlier `still` run (about $0.27 per candidate, $1.08 for 4).

A generated sheet makes one `sheet` call and one `vision` call for the grouping proposal: about $0.32, reserved against the $5 cap before either call.

Each route records its provider terms in provenance. The values name the terms in force on 2026-11-07; check and update them when a route changes.
