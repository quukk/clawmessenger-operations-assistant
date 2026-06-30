/**
 * Skill 加载器
 *
 * 自动扫描 service/skills/ 下的子目录，加载 index.js 并实例化 skill。
 * 仅加载继承 BaseSkill 的类，实例化后注入 messageSender 并调用 init()。
 */
const fs = require('fs');
const path = require('path');
const { BaseSkill } = require('./base-skill');

class SkillLoader {
  /**
   * @param {string} skillsDir - skill 根目录
   * @param {Object} log - 日志对象
   */
  constructor(skillsDir, log) {
    this.skillsDir = skillsDir;
    this.log = log || console;
    this.skills = [];
  }

  /**
   * 从模块导出中解析 Skill 类
   * 支持：module.exports = SkillClass / { default: SkillClass } / { SkillClass } / { AnyName: SkillClass }
   * @param {Object} skillModule
   * @param {string} dirName
   * @returns {Function|null}
   */
  _resolveSkillClass(skillModule, dirName) {
    if (!skillModule) return null;

    // 1. 优先 common 约定名
    if (typeof skillModule.default === 'function') return skillModule.default;
    if (typeof skillModule.SkillClass === 'function') return skillModule.SkillClass;

    // 2. 如果整个模块直接是函数
    if (typeof skillModule === 'function') return skillModule;

    // 3. 遍历所有导出，找第一个函数（类）
    const keys = Object.keys(skillModule);
    for (const key of keys) {
      const exported = skillModule[key];
      if (typeof exported === 'function') {
        return exported;
      }
    }

    return null;
  }

  /**
   * 加载所有 skill
   *
   * @param {Object} config - 全局配置
   * @param {Object} messageSender - 消息发送器实例
   * @returns {Promise<BaseSkill[]>}
   */
  async loadAll(config, messageSender) {
    this.skills = [];

    if (!fs.existsSync(this.skillsDir)) {
      this.log.warn(`[SkillLoader] Skills directory not found: ${this.skillsDir}`);
      return this.skills;
    }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());

    for (const dir of dirs) {
      const skillPath = path.join(this.skillsDir, dir.name, 'index.js');
      if (!fs.existsSync(skillPath)) {
        this.log.debug(`[SkillLoader] Skip ${dir.name}: index.js not found`);
        continue;
      }

      try {
        const SkillModule = require(skillPath);
        const SkillClass = this._resolveSkillClass(SkillModule, dir.name);

        if (!SkillClass) {
          this.log.warn(`[SkillLoader] ${dir.name}: exported SkillClass is not a function`);
          continue;
        }

        // 实例化时传入 name 等元信息
        const skill = new SkillClass({
          name: dir.name,
          config,
          log: this.log,
        });

        if (!(skill instanceof BaseSkill)) {
          this.log.warn(`[SkillLoader] ${dir.name}: does not extend BaseSkill`);
          continue;
        }

        skill.messageSender = messageSender;
        await skill.init();

        this.skills.push(skill);
        this.log.info(
          `[SkillLoader] Skill loaded: ${skill.name} (priority=${skill.priority})`
        );
      } catch (err) {
        this.log.error(`[SkillLoader] Failed to load skill ${dir.name}: ${err.message}`);
      }
    }

    // 按静态优先级降序排序
    this.skills.sort((a, b) => b.priority - a.priority);

    this.log.info(`[SkillLoader] Total skills loaded: ${this.skills.length}`);
    return this.skills;
  }

  /**
   * 获取已加载的 skill 列表
   * @returns {BaseSkill[]}
   */
  getSkills() {
    return this.skills;
  }

  /**
   * 卸载所有 skill
   * @returns {Promise<void>}
   */
  async unloadAll() {
    for (const skill of this.skills) {
      try {
        await skill.destroy();
      } catch (err) {
        this.log.error(`[SkillLoader] Error destroying skill ${skill.name}: ${err.message}`);
      }
    }
    this.skills = [];
  }
}

module.exports = { SkillLoader };
