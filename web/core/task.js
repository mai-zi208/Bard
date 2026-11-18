/**
 * 生成任务：提交主题、轮询状态。
 * 生产端尚未接入时，可用 server/ 的本地服务提供任务接口。
 */
const config = require('../config');

function request(method, url, data) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (config.API_TOKEN) headers['x-api-token'] = config.API_TOKEN;

    wx.request({
      url: (config.API_BASE || '') + url,
      method: method,
      data: data,
      header: headers,
      timeout: config.REQUEST_TIMEOUT || 5000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
          return;
        }
        const data = res.data || {};
        const err = new Error(data.error || 'HTTP ' + res.statusCode);
        err.statusCode = res.statusCode;
        reject(err);
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

function submit(topic, persona) {
  return request('POST', '/tasks', { topic: topic, persona: persona || '' });
}

function poll(taskId) {
  return request('GET', '/tasks/' + taskId);
}

module.exports = {
  submit: submit,
  poll: poll
};
