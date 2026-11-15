/**
 * External fine-tuning provider plans.
 *
 * Stella never runs training itself: it writes a validated dataset and a
 * provider-specific plan. DeepSeek has no fine-tuning endpoint, which is stated
 * explicitly instead of being papered over.
 */

import { config } from '../config.ts'
import { getDb, type Db } from '../db/index.ts'
import { now } from '../../../shared/ids.ts'
import { BusinessError } from '../evals/errors.ts'
import { readExportManifest, getFinetuneExport } from './pipeline.ts'

export type FinetuneProviderId =
  | 'unsloth'
  | 'axolotl'
  | 'together'
  | 'openai-compatible'
  | 'deepseek'

export const FINETUNE_PROVIDERS: FinetuneProviderId[] = [
  'unsloth',
  'axolotl',
  'together',
  'openai-compatible',
  'deepseek',
]

export const DEEPSEEK_FINETUNE_DOCS =
  'https://api-docs.deepseek.com/ (no fine-tuning endpoint is documented on api.deepseek.com)'

export const DEEPSEEK_UNAVAILABLE_MESSAGE =
  'DeepSeek does not offer fine-tuning on api.deepseek.com. Stella can build validated SFT/ShareGPT/DPO data and plans for Unsloth, Axolotl, Together or an OpenAI-compatible endpoint, but it never claims a DeepSeek tuned model ran.'

const DEFAULT_BASE_MODELS: Record<FinetuneProviderId, string> = {
  unsloth: 'unsloth/Qwen2.5-7B-Instruct-bnb-4bit',
  axolotl: 'Qwen/Qwen2.5-7B-Instruct',
  together: 'meta-llama/Llama-3.1-8B-Instruct',
  'openai-compatible': 'gpt-4o-mini',
  deepseek: 'deepseek-flash',
}

export type FinetunePlan = {
  provider: FinetuneProviderId
  available: boolean
  reason: string | null
  docs: string[]
  baseModel: string
  format: string
  exportId: string
  exportPath: string
  manifestPath: string
  dataset: { name: string; version: number; contentHash: string }
  files: string[]
  planFormat: 'python' | 'yaml' | 'json' | 'none'
  plan: string | null
  command: string | null
  notes: string[]
  createdAt: number
}

const quote = (value: string): string =>
  `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

const unslothPlan = (input: {
  baseModel: string
  format: string
  files: string[]
  exportDir: string
}): string => {
  const dpo = input.format === 'dpo'
  return `# Stella fine-tuning plan — Unsloth (run on a GPU machine, not in Stella)
# Dataset: ${input.files.join(', ')}
# Install: pip install "unsloth[cu121] @ git+https://github.com/unslothai/unsloth.git"
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=${quote(input.baseModel)},
    max_seq_length=4096,
    load_in_4bit=True,
)
model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=32, lora_dropout=0, bias="none",
    use_gradient_checkpointing="unsloth", random_state=${42},
)

train_file = ${quote(input.files[0] ?? `${input.exportDir}/train.jsonl`)}
val_file = ${quote(input.files[1] ?? `${input.exportDir}/val.jsonl`)}

${
  dpo
    ? `from datasets import load_dataset
from trl import DPOTrainer, DPOConfig
dataset = load_dataset("json", data_files={"train": train_file, "validation": val_file})
trainer = DPOTrainer(
    model=model, tokenizer=tokenizer,
    args=DPOConfig(output_dir="stella-dpo-out", per_device_train_batch_size=2, num_train_epochs=1, learning_rate=5e-6, eval_strategy="steps", eval_steps=50),
    train_dataset=dataset["train"], eval_dataset=dataset["validation"],
)`
    : `from datasets import load_dataset
from trl import SFTTrainer, SFTConfig
dataset = load_dataset("json", data_files={"train": train_file, "validation": val_file})
trainer = SFTTrainer(
    model=model, tokenizer=tokenizer,
    args=SFTConfig(output_dir="stella-sft-out", per_device_train_batch_size=2, num_train_epochs=1, learning_rate=2e-4, eval_strategy="steps", eval_steps=50),
    train_dataset=dataset["train"], eval_dataset=dataset["validation"],
)`
}

trainer.train()
model.save_pretrained("stella-finetuned")
tokenizer.save_pretrained("stella-finetuned")
# Evaluate externally, then re-import the adapter and run a Stella eval before shipping.
`
}

const axolotlPlan = (input: { baseModel: string; format: string; files: string[] }): string => {
  const dpo = input.format === 'dpo'
  return `# Stella fine-tuning plan — Axolotl (run externally)
base_model: ${input.baseModel}
datasets:
  - path: ${input.files[0] ?? 'train.jsonl'}
    type: ${dpo ? 'chat_template.dpo' : 'chat_template.default'}
  - path: ${input.files[1] ?? 'val.jsonl'}
    type: ${dpo ? 'chat_template.dpo' : 'chat_template.default'}
    split: validation
output_dir: ./stella-finetuned
${
  dpo
    ? `rl: dpo
dpo_beta: 0.1
`
    : ''
}sequence_len: 4096
micro_batch_size: 2
gradient_accumulation_steps: 4
learning_rate: ${dpo ? '5e-6' : '2e-4'}
num_epochs: 1
lora_r: 16
lora_alpha: 32
lora_dropout: 0.0
lora_target_modules: [q_proj, k_proj, v_proj, o_proj]
# DeepSeek has no fine-tuning endpoint, so this plan targets an open base model.
`
}

const togetherPlan = (input: {
  baseModel: string
  files: string[]
  exportDir: string
  manifestPath: string
}): string =>
  JSON.stringify(
    {
      provider: 'together',
      docs: 'https://docs.together.ai/docs/fine-tuning',
      steps: [
        `Upload the JSONL training file(s): ${input.files.join(', ')}`,
        'Create a Together fine-tune job with the model + training file id below.',
      ],
      upload_endpoint: 'POST https://api.together.xyz/v1/files (purpose=fine-tune)',
      create_job_endpoint: 'POST https://api.together.xyz/v1/fine-tunes',
      create_job_body: {
        model: input.baseModel,
        training_file: '<file id from upload>',
        n_epochs: 1,
        learning_rate: 1e-5,
        suffix: 'stella',
      },
      local_files: {
        export_dir: input.exportDir,
        manifest: input.manifestPath,
        data: input.files,
      },
      note: 'Stella does not upload data itself; run the upload with your own key.',
    },
    null,
    2
  )

const openAiCompatiblePlan = (input: {
  baseModel: string
  files: string[]
  exportDir: string
}): string =>
  JSON.stringify(
    {
      provider: 'openai-compatible',
      docs: 'https://platform.openai.com/docs/guides/fine-tuning',
      steps: [
        `Upload ${input.files.join(', ')} via POST /v1/files with purpose=fine-tune.`,
        'Create a job via POST /v1/fine_tuning/jobs.',
      ],
      upload_endpoint: 'POST {baseUrl}/v1/files',
      create_job_endpoint: 'POST {baseUrl}/v1/fine_tuning/jobs',
      create_job_body: { model: input.baseModel, training_file: '<file id>', suffix: 'stella' },
      local_files: { export_dir: input.exportDir, data: input.files },
      note: 'Point baseUrl at any OpenAI-compatible endpoint. Stella does not upload data itself.',
    },
    null,
    2
  )

export type PlanFinetuneInput = {
  exportId: string
  provider: FinetuneProviderId
  baseModel?: string
}

/** Build a provider plan for a validated export. */
export const planFinetune = (input: PlanFinetuneInput, options: { db?: Db } = {}): FinetunePlan => {
  const db = options.db ?? getDb()
  const provider = input.provider
  if (!FINETUNE_PROVIDERS.includes(provider)) {
    throw new BusinessError(
      `unknown fine-tuning provider "${String(provider)}" (choose ${FINETUNE_PROVIDERS.join(', ')})`,
      'invalid_provider',
      400
    )
  }
  const exportValue = getFinetuneExport(input.exportId, db)
  const manifest = readExportManifest(exportValue, db)
  const baseModel = input.baseModel?.trim() || DEFAULT_BASE_MODELS[provider]
  const files = [
    `${exportValue.path}/${exportValue.format}-train.jsonl`,
    `${exportValue.path}/${exportValue.format}-val.jsonl`,
    `${exportValue.path}/${exportValue.format}-holdout.jsonl`,
  ]
  const common = {
    provider,
    baseModel,
    format: exportValue.format,
    exportId: exportValue.id,
    exportPath: exportValue.path,
    manifestPath: exportValue.manifestPath,
    dataset: {
      name: exportValue.datasetName,
      version: exportValue.datasetVersion,
      contentHash: manifest.dataset.contentHash,
    },
    files,
    createdAt: now(),
  }
  if (provider === 'deepseek') {
    return {
      ...common,
      available: false,
      reason: DEEPSEEK_UNAVAILABLE_MESSAGE,
      docs: [DEEPSEEK_FINETUNE_DOCS],
      planFormat: 'none',
      plan: null,
      command: null,
      notes: [
        'No fine-tuning execution is possible against api.deepseek.com.',
        'The exported data can still be used with an external provider; DeepSeek permits using model outputs for training elsewhere.',
      ],
    }
  }
  if (provider === 'unsloth') {
    return {
      ...common,
      available: true,
      reason: null,
      docs: ['https://github.com/unslothai/unsloth'],
      planFormat: 'python',
      plan: unslothPlan({
        baseModel,
        format: exportValue.format,
        files,
        exportDir: exportValue.path,
      }),
      command: 'python stella-unsloth-plan.py',
      notes: [
        'Requires a CUDA GPU and Python; Stella does not run training.',
        'Verify split integrity and holdout contamination before shipping the adapter.',
      ],
    }
  }
  if (provider === 'axolotl') {
    return {
      ...common,
      available: true,
      reason: null,
      docs: ['https://docs.axolotl.ai/'],
      planFormat: 'yaml',
      plan: axolotlPlan({ baseModel, format: exportValue.format, files }),
      command: 'axolotl train stella-axolotl.yml',
      notes: ['Requires Python + Axolotl; Stella does not run training.'],
    }
  }
  if (provider === 'together') {
    return {
      ...common,
      available: true,
      reason: null,
      docs: ['https://docs.together.ai/docs/fine-tuning'],
      planFormat: 'json',
      plan: togetherPlan({
        baseModel,
        files,
        exportDir: exportValue.path,
        manifestPath: exportValue.manifestPath,
      }),
      command: 'see plan JSON — upload then create a job',
      notes: [
        'Stella does not upload data or call Together; `stella finetune job --provider together` submits a job only when TOGETHER_API_KEY is set.',
      ],
    }
  }
  return {
    ...common,
    available: true,
    reason: null,
    docs: ['https://platform.openai.com/docs/guides/fine-tuning'],
    planFormat: 'json',
    plan: openAiCompatiblePlan({ baseModel, files, exportDir: exportValue.path }),
    command: 'see plan JSON — upload then create a job',
    notes: [
      'Stella does not upload data or call the endpoint by default; job submission requires OPENAI_API_KEY.',
    ],
  }
}

/** Provider env var that holds the API key for job submission. */
export const providerApiKeyEnv = (provider: FinetuneProviderId): string | null => {
  if (provider === 'together') {
    return 'TOGETHER_API_KEY'
  }
  if (provider === 'openai-compatible') {
    return 'OPENAI_API_KEY'
  }
  return null
}

export const stellaVersion = (): string => config.version
