import { prisma } from '../db.js';
import { enc } from '../crypto.js';

/** Configuração de IA global (singleton id="global"). */
export async function getPlatformConfig() {
  return prisma.platformConfig.upsert({ where: { id: 'global' }, update: {}, create: { id: 'global' } });
}

export type PlatformPatch = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  clearKey?: boolean;
  crmProvider?: string;
  crmModel?: string;
  crmBaseUrl?: string;
  crmApiKey?: string;
  clearCrmKey?: boolean;
  autoStage?: boolean;
  mediaApiKey?: string;
  mediaModel?: string;
  clearMediaKey?: boolean;
  // Google Ads global (MCC)
  gadsClientId?: string;
  gadsClientSecret?: string;
  gadsDeveloperToken?: string;
  gadsLoginCustomerId?: string;
  gadsRefreshToken?: string;
  clearGadsSecret?: boolean;
  clearGadsDeveloperToken?: boolean;
  clearGadsRefreshToken?: boolean;
};

export async function updatePlatformConfig(data: PlatformPatch) {
  await getPlatformConfig();
  const patch: Record<string, unknown> = {};
  if (typeof data.provider === 'string') patch.provider = data.provider;
  if (typeof data.model === 'string') patch.model = data.model;
  if (typeof data.baseUrl === 'string') patch.baseUrl = data.baseUrl.trim();
  if (data.clearKey) patch.apiKey = '';
  else if (typeof data.apiKey === 'string' && data.apiKey.trim()) patch.apiKey = enc(data.apiKey.trim());
  if (typeof data.crmProvider === 'string') patch.crmProvider = data.crmProvider;
  if (typeof data.crmModel === 'string') patch.crmModel = data.crmModel;
  if (typeof data.crmBaseUrl === 'string') patch.crmBaseUrl = data.crmBaseUrl.trim();
  if (data.clearCrmKey) patch.crmApiKey = '';
  else if (typeof data.crmApiKey === 'string' && data.crmApiKey.trim()) patch.crmApiKey = enc(data.crmApiKey.trim());
  if (typeof data.autoStage === 'boolean') patch.autoStage = data.autoStage;
  if (typeof data.mediaModel === 'string') patch.mediaModel = data.mediaModel.trim();
  if (data.clearMediaKey) patch.mediaApiKey = '';
  else if (typeof data.mediaApiKey === 'string' && data.mediaApiKey.trim()) patch.mediaApiKey = enc(data.mediaApiKey.trim());

  // Google Ads global (MCC)
  if (typeof data.gadsClientId === 'string') patch.gadsClientId = data.gadsClientId.trim();
  if (typeof data.gadsLoginCustomerId === 'string') patch.gadsLoginCustomerId = data.gadsLoginCustomerId.replace(/\D/g, '');
  if (data.clearGadsSecret) patch.gadsClientSecret = '';
  else if (typeof data.gadsClientSecret === 'string' && data.gadsClientSecret.trim()) patch.gadsClientSecret = enc(data.gadsClientSecret.trim());
  if (data.clearGadsDeveloperToken) patch.gadsDeveloperToken = '';
  else if (typeof data.gadsDeveloperToken === 'string' && data.gadsDeveloperToken.trim()) patch.gadsDeveloperToken = enc(data.gadsDeveloperToken.trim());
  if (data.clearGadsRefreshToken) patch.gadsRefreshToken = '';
  else if (typeof data.gadsRefreshToken === 'string' && data.gadsRefreshToken.trim()) patch.gadsRefreshToken = enc(data.gadsRefreshToken.trim());

  return prisma.platformConfig.update({ where: { id: 'global' }, data: patch });
}
