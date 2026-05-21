const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

/**
 * 文件上传服务
 * 
 * 架构：
 * 1. 调用服务端 requestUpload 获取上传配置
 * 2. 根据配置选择上传方式：
 *    - server_proxy: 通过服务端代理上传
 *    - direct: 直传到 OSS（未来支持）
 * 3. 返回下载 URL
 * 
 * @param {Object} config - 配置对象
 * @param {string} config.apiBaseUrl - API 基础地址
 * @param {Function} log - 日志函数
 */
class UploadService {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.apiBaseUrl = config.apiBaseUrl;
  }

  /**
   * 上传文件
   * 
   * @param {Object} options
   * @param {string} options.filePath - 本地文件路径
   * @param {string} options.fileType - 文件类型 (image, video, audio, file)
   * @param {string} options.fileName - 原始文件名
   * @param {number} options.fileSize - 文件大小
   * @param {Function} options.onProgress - 进度回调 (progress: number) => void
   * @returns {Promise<{url: string, filename: string}>}
   */
  async uploadFile(options) {
    const { filePath, fileType = 'file', fileName = '', fileSize = 0, onProgress } = options;

    if (!filePath) {
      throw new Error('filePath 不能为空');
    }

    this.log?.info(`[UploadService] 开始上传: filePath=${filePath}, type=${fileType}`);

    try {
      // 1. 请求上传配置
      const uploadConfig = await this._requestUpload(fileType, fileName, fileSize);
      this.log?.info(`[UploadService] 获取上传配置: mode=${uploadConfig.mode}`);

      // 2. 根据模式上传
      let result;
      if (uploadConfig.mode === 'direct' && uploadConfig.presignedUrl) {
        // 直传模式（OSS 预签名 URL）
        result = await this._uploadDirect(filePath, uploadConfig, onProgress);
      } else {
        // 服务端代理模式
        result = await this._uploadViaServer(filePath, uploadConfig, onProgress);
      }

      this.log?.info(`[UploadService] 上传成功: url=${result.url}`);
      return result;
    } catch (err) {
      this.log?.error(`[UploadService] 上传失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 请求上传配置
   */
  async _requestUpload(fileType, fileName, fileSize) {
    const url = `${this.apiBaseUrl}/im/api/system/service`;
    
    const payload = {
      service: 'upload',
      action: 'requestUpload',
      payload: {
        fileType,
        fileName,
        fileSize,
      },
    };

    this.log?.info(`[UploadService] 请求上传配置: ${url}`);

    const response = await axios.post(url, payload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (response.data?.code !== 200) {
      throw new Error(response.data?.message || '获取上传配置失败');
    }

    return response.data.data;
  }

  /**
   * 通过服务端代理上传
   */
  async _uploadViaServer(filePath, uploadConfig, onProgress) {
    const { uploadUrl, method, formData, fileField, headers } = uploadConfig;

    // 读取文件
    const fileBuffer = fs.readFileSync(filePath);
    
    // 构建 FormData
    const form = new FormData();
    
    // 添加表单字段
    if (formData) {
      Object.entries(formData).forEach(([key, value]) => {
        form.append(key, value);
      });
    }
    
    // 添加文件
    form.append(fileField || 'file', fileBuffer, {
      filename: uploadConfig.fileName || path.basename(filePath),
    });

    this.log?.info(`[UploadService] 服务端代理上传: ${uploadUrl}`);

    const response = await axios({
      method: method || 'POST',
      url: uploadUrl,
      data: form,
      headers: {
        ...headers,
        ...form.getHeaders(),
      },
      timeout: 120000, // 2分钟
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress?.(progress);
        }
      },
    });

    if (response.data?.code !== 200) {
      throw new Error(response.data?.message || '上传失败');
    }

    return {
      url: response.data.data?.url || uploadConfig.downloadUrl,
      filename: response.data.data?.filename || uploadConfig.fileName,
    };
  }

  /**
   * 直传到 OSS（预签名 URL）
   * 未来支持阿里云 OSS、腾讯云 COS 等
   */
  async _uploadDirect(filePath, uploadConfig, onProgress) {
    const { presignedUrl, downloadUrl, headers = {} } = uploadConfig;

    const fileBuffer = fs.readFileSync(filePath);

    this.log?.info(`[UploadService] 直传上传: ${presignedUrl}`);

    await axios.put(presignedUrl, fileBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        ...headers,
      },
      timeout: 120000,
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress?.(progress);
        }
      },
    });

    return {
      url: downloadUrl,
      filename: uploadConfig.fileName,
    };
  }
}

module.exports = { UploadService };
