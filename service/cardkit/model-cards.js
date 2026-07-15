/**
 * CardKit 模型选择卡片构造器(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/model-cards.ts 翻译而来。
 * 签名/行为/字段名与 TS 版逐字一致。
 */

'use strict';

const {
  card: buildCard,
  kv,
  select,
  note,
  action,
  buttons,
  btn,
} = require('./builders');

const MODELS_PER_CARD_LIMIT = 15;

/**
 * @typedef {Object} ModelInfo
 * @property {string} id
 * @property {string} name
 */

/**
 * @typedef {Object} ProviderInfo
 * @property {string} id
 * @property {string} name
 * @property {ModelInfo[]} models
 */

/**
 * 构造"服务商选择"卡片。
 * @param {ProviderInfo[]} providers
 * @param {string} [currentModel]
 * @returns {import('./schema').CardModel}
 */
function buildProviderListCard(providers, currentModel) {
  /** @type {import('./schema').CardSection[]} */
  const sections = [];
  if (currentModel) {
    sections.push(kv([{ label: '当前模型', value: currentModel }]));
  }
  sections.push(
    buttons(
      providers.map((p) =>
        btn(p.name, action.custom('list_models', { provider: p.id }), { variant: 'default' }),
      ),
      'flow',
    ),
  );
  if (providers.length > 0) {
    sections.push(note('点击服务商查看可用模型'));
  }
  return buildCard(
    `models_providers_${Date.now()}`,
    '🤖 选择模型服务商',
    sections,
    { color: 'blue' },
  );
}

/**
 * 构造单个服务商的"模型选择"卡片。
 * @param {ProviderInfo} provider
 * @param {string} [currentModel]
 * @returns {import('./schema').CardModel}
 */
function buildModelsCard(provider, currentModel) {
  const modelsToShow = provider.models.slice(0, MODELS_PER_CARD_LIMIT);
  /** @type {import('./schema').CardSection[]} */
  const sections = [];
  if (currentModel) {
    sections.push(kv([{ label: '当前模型', value: currentModel }]));
  }
  sections.push(
    select(
      `选择 ${provider.name} 模型`,
      modelsToShow.map((m) => ({ label: m.name, value: `${provider.id}/${m.id}` })),
      action.custom('switch_model', { provider: provider.id }),
    ),
  );
  if (provider.models.length > MODELS_PER_CARD_LIMIT) {
    sections.push(
      note(`仅展示前 ${MODELS_PER_CARD_LIMIT} 个模型，共 ${provider.models.length} 个。`),
    );
  }
  return buildCard(
    `models_${provider.id}_${Date.now()}`,
    `🤖 选择 ${provider.name} 模型`,
    sections,
    { color: 'blue' },
  );
}

module.exports = {
  buildProviderListCard,
  buildModelsCard,
};
