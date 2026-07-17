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

/**
 * 构造"模型级联选择"卡片 —— 供应商 select + 模型 select 同卡。
 *
 * 两种形态(由 selectedProvider 区分):
 *  - 第一级(未选供应商): note(当前模型) + select(供应商列表, action=custom('list_models'))
 *      前端约定:用户选供应商后,前端把 option.value 并入 action.payload.value 回传。
 *  - 第二级(已选供应商): note(当前模型) + select(供应商, 选中态, action=custom('list_models'))
 *                        + select(模型列表, action=custom('switch_model', {provider}))
 *      model select 的 action.payload 带 provider,便于 switch_model 时后端校验/定位。
 *
 * 第二级用于 card_update(整体替换同 cardId 的卡片),cardId 必须与第一级一致。
 *
 * @param {ProviderInfo[]} providers 完整供应商列表(第一级/第二级都用,渲染供应商 select)
 * @param {string} [currentModel] 当前模型全名(如 "anthropic/claude-3.5"),展示在 note
 * @param {string} [selectedProvider] 已选供应商 id(有值则渲染第二级形态)
 * @param {ModelInfo[]} [providerModels] 已选供应商的模型列表(第二级必填)
 * @param {string} [cardId] 卡片 id;第二级(card_update)必须与第一级一致。未提供时自动生成
 * @returns {import('./schema').CardModel}
 */
function buildModelCascadeCard(providers, currentModel, selectedProvider, providerModels, cardId) {
  /** @type {import('./schema').CardSection[]} */
  const sections = [];

  // note: 当前模型
  sections.push(note(`当前模型：${currentModel || '未选择'}`));

  // select 1: 供应商(无论第几级都渲染,第二级保持选中态供用户切换供应商)
  const providerOptions = (providers || []).map((p) => ({ label: p.name, value: p.id }));
  sections.push(
    select('选择供应商', providerOptions, action.custom('list_models')),
  );

  // select 2: 模型(仅第二级渲染)
  if (selectedProvider) {
    const providerInfo = (providers || []).find((p) => p.id === selectedProvider);
    const providerName = (providerInfo && providerInfo.name) || selectedProvider;
    let models = Array.isArray(providerModels) ? providerModels : [];
    let truncatedNote = '';
    if (models.length > MODELS_PER_CARD_LIMIT) {
      truncatedNote = `仅展示前 ${MODELS_PER_CARD_LIMIT} 个模型，共 ${models.length} 个。`;
      models = models.slice(0, MODELS_PER_CARD_LIMIT);
    }
    const modelOptions = models.map((m) => ({ label: m.name, value: `${selectedProvider}/${m.id}` }));
    sections.push(
      select(`选择 ${providerName} 模型`, modelOptions, action.custom('switch_model', { provider: selectedProvider })),
    );
    if (truncatedNote) {
      sections.push(note(truncatedNote));
    }
  } else {
    sections.push(note('请先选择供应商'));
  }

  const id = cardId || `models_cascade_${Date.now()}`;
  return buildCard(
    id,
    '🤖 选择模型',
    sections,
    { color: 'blue' },
  );
}

/**
 * 构造"切换成功"反馈卡片(切换模型后 card_update 替换原级联卡)。
 *
 * @param {string} cardId 原卡片 id(card_update 复用)
 * @param {string} model 已切换的模型全名(如 "anthropic/claude-3.5")
 * @returns {import('./schema').CardModel}
 */
function buildModelSwitchedCard(cardId, model) {
  return buildCard(
    cardId || `models_switched_${Date.now()}`,
    '✅ 已切换模型',
    [note(`已切换至 ${model}`)],
    { color: 'green' },
  );
}

module.exports = {
  buildProviderListCard,
  buildModelsCard,
  buildModelCascadeCard,
  buildModelSwitchedCard,
  MODELS_PER_CARD_LIMIT,
};
