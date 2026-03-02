// HexGrid — Domain Auto-Classification
// Pure function, zero LLM cost. Keyword map scoring.

import type { Domain } from './types'

const DOMAIN_KEYWORDS: Record<Exclude<Domain, 'other'>, string[]> = {
  coding: [
    'typescript', 'javascript', 'python', 'code', 'debug', 'api', 'react',
    'deploy', 'test', 'refactor', 'architecture', 'backend', 'frontend',
    'fullstack', 'devops', 'ci', 'cd', 'git', 'database', 'sql', 'graphql',
    'rust', 'go', 'java', 'node', 'docker', 'kubernetes', 'aws', 'gcp',
    'azure', 'terraform', 'infrastructure', 'microservice', 'serverless',
    'webpack', 'vite', 'nextjs', 'svelte', 'vue', 'angular', 'css', 'html',
    'compiler', 'parser', 'lint', 'format', 'build', 'ship', 'engineer',
  ],
  data: [
    'data', 'analytics', 'pipeline', 'ml', 'model', 'visualization',
    'statistics', 'etl', 'warehouse', 'bigquery', 'snowflake', 'spark',
    'hadoop', 'pandas', 'numpy', 'tensorflow', 'pytorch', 'scikit',
    'dataset', 'feature', 'training', 'inference', 'classification',
    'regression', 'clustering', 'nlp', 'computer-vision', 'embedding',
    'vector', 'rag', 'llm', 'fine-tune', 'notebook', 'jupyter',
  ],
  legal: [
    'legal', 'contract', 'compliance', 'regulation', 'gdpr', 'patent',
    'trademark', 'copyright', 'litigation', 'arbitration', 'clause',
    'liability', 'indemnity', 'terms', 'privacy-policy', 'nda',
    'intellectual-property', 'licensing', 'regulatory', 'statute',
    'jurisdiction', 'attorney', 'counsel', 'tort', 'dispute',
  ],
  finance: [
    'finance', 'accounting', 'invoice', 'tax', 'audit', 'budget',
    'forecast', 'revenue', 'expense', 'payroll', 'bookkeeping',
    'financial', 'balance-sheet', 'profit', 'loss', 'cash-flow',
    'valuation', 'investment', 'portfolio', 'equity', 'debt',
    'crypto', 'defi', 'trading', 'risk', 'insurance', 'pricing',
  ],
  marketing: [
    'marketing', 'seo', 'content', 'social', 'campaign', 'brand',
    'growth', 'ads', 'advertising', 'funnel', 'conversion', 'cro',
    'email-marketing', 'newsletter', 'engagement', 'audience',
    'influencer', 'pr', 'public-relations', 'media', 'analytics',
    'ab-test', 'retention', 'acquisition', 'viral', 'organic',
  ],
  writing: [
    'writing', 'copywriting', 'editing', 'blog', 'documentation',
    'translation', 'proofreading', 'grammar', 'article', 'essay',
    'technical-writing', 'creative-writing', 'screenplay', 'script',
    'ghostwriting', 'ebook', 'whitepaper', 'proposal', 'report',
    'narrative', 'storytelling', 'publish', 'author', 'editorial',
  ],
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}

export interface ClassifyResult {
  domain: Domain
  confidence: number
  auto: boolean
}

export function classifyDomain(
  capabilities: string[],
  description: string,
): ClassifyResult {
  const tokens = new Set([
    ...capabilities.flatMap(c => tokenise(c)),
    ...tokenise(description),
  ])

  const scores: Record<string, number> = {}
  let maxScore = 0
  let maxDomain: Domain = 'other'

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.filter(kw => tokens.has(kw)).length
    scores[domain] = score
    if (score > maxScore) {
      maxScore = score
      maxDomain = domain as Domain
    }
  }

  // Check for ties
  if (maxScore === 0) {
    return { domain: 'other', confidence: 0, auto: true }
  }

  const tiedDomains = Object.entries(scores).filter(([, s]) => s === maxScore)
  if (tiedDomains.length > 1) {
    return { domain: 'other', confidence: 0, auto: true }
  }

  const totalTokens = tokens.size || 1
  const confidence = Math.min(1, maxScore / Math.max(3, totalTokens))

  return { domain: maxDomain, confidence: Math.round(confidence * 100) / 100, auto: true }
}
