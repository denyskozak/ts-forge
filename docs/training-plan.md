# Training a TypeScript specialist

## Goal

Improve correctness on your own TypeScript/React/Next.js tasks without trading away tool use, general coding ability, or privacy. Start by measuring the base model: stronger prompts and better context may outperform a small fine-tune.

## 1. Establish a baseline

Keep a fixed private evaluation set of representative repository tasks: discriminated unions, generic API types, hook dependencies, component accessibility, server/client boundaries, and real regressions. Split by project/task family, not random variants of the same question. Include tasks that require reading and editing multiple files.

Record successful typechecks, behavior tests, accidental changes, tool call failures, latency, and peak memory. A model's verbal claim that a task is solved is not a passing result.

## 2. Curate examples

Use examples from code you own or are licensed to train on. Include enough source context for each answer to be understandable. Prefer corrected, verified code and explanations of important constraints. Strip secrets and personal information. Keep some ordinary TypeScript examples so specialization does not become memorization of one repository.

The current Training Lab stores user/assistant pairs, with task/tool context and provenance for captured drafts. Export requires review, rejects conflicting duplicate prompts, and splits task families deterministically into training, validation and test partitions (roughly 60/20/20 by groups). Manually audit related examples for leakage. Five examples across at least three groups only exercises the pipeline. Collect a substantially larger, diverse corpus before judging model quality.

Do not treat a model's unreviewed outputs as ground truth. Saving a chat answer requires user review; Forge does not train automatically.

## 3. Run a small LoRA experiment

Start with a compatible local MLX model, a small batch, low learning rate, and a short run. Track training and validation loss, available memory, and qualitative changes. Prompt masking trains on the answer. Compare multiple checkpoints rather than assuming the final one is best.

A decreasing training loss alone does not establish coding improvement. Keep the final held-out evaluation set outside the training and validation datasets.

## 4. Evaluate before adoption

Re-run the baseline tasks with the adapter using MLX generation and a controlled harness. Compare compiler/test outcomes and tool-calling behavior. Reject adapters that regress critical workflows. Evaluate tasks with unseen APIs and file structures to expose memorization.

The app launches training. `npm run eval:local` provides two initial coding fixtures through Ollama; a full adapter evaluation runner is still required.

## 5. Integrate the winning adapter

Fuse into the exact compatible base model, convert to a supported inference format, quantize if needed, import into the local serving runtime, and repeat the same evaluation after conversion. Preserve the original model so switching back is immediate. Do not assume every MLX architecture/adapter is directly importable by Ollama.

Automatic fusion, import and model promotion are future work.

## Next milestones

- Repository snapshots and behavior-based TypeScript benchmark runner.
- Full tool trajectories as a separate, schema-validated dataset format.
- Versioned datasets with provenance, task-family splits and secret scanning.
- Checkpoint comparison, resume and full reproducibility metadata; job history is now available.
- Adapter inference through a local MLX provider before any format conversion.
- Extend the existing isolated compiler and targeted edit tools with a safe project test runner.
- Extend the current project map/context budget to exact token accounting and measure larger-project retrieval quality.
