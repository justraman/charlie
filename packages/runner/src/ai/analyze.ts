// Orchestrates one AI analysis on the compute plane: pull the analysis config
// (repo/ref + provider creds) with the analysis token, extract the repo's static
// surface, ask the provider for drafts, and POST them back for validation and
// storage. The source repo is checked out by the workflow; this reads it from
// `repoDir`.

import { type AnalysisConfig, fetchAnalysisConfig, postDrafts, type RunnerConfig } from '../api'
import { getProvider, type ProviderConfig } from './provider'
import { extractSurface } from './surface'

export interface AnalyzeOptions {
  cfg: RunnerConfig
  analysisId: string
  repoDir: string
}

export async function runAnalyze(opts: AnalyzeOptions): Promise<void> {
  const { cfg, analysisId, repoDir } = opts
  const config: AnalysisConfig = await fetchAnalysisConfig(cfg, analysisId)

  const surface = extractSurface(repoDir)
  console.info(
    `[charlie] surface: ${surface.files} files, ${surface.routes.length} routes, ` +
      `${surface.forms.length} forms, ${surface.testIds.length} test-ids, ` +
      `framework=${surface.framework.join(',') || 'unknown'}`,
  )

  const providerCfg: ProviderConfig = {
    name: (config.provider.name ?? 'anthropic') as ProviderConfig['name'],
    model: config.provider.model ?? '',
    apiKey: config.provider.apiKey,
    accountId: config.provider.accountId,
  }
  const provider = getProvider(providerCfg)
  const drafts = await provider.analyze(surface)
  console.info(`[charlie] drafted ${drafts.length} flow(s) via ${provider.name}`)

  await postDrafts(cfg, analysisId, drafts)
  console.info(`[charlie] posted ${drafts.length} draft(s) for analysis ${analysisId}`)
}
