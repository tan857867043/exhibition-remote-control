
const http = require('http');
const { initWSServer, handleApi } = require('./hub/router');

const server = http.createServer(handleApi);
initWSServer(server);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`服务启动成功 :${PORT}`);
  console.log(`设备注册：ws://127.0.0.1:${PORT}/agent/register`);
  console.log(`画面订阅：ws://127.0.0.1:${PORT}/api/v1/stream`);
});

process.on('uncaughtException', e => console.error("异常：", e.message));
process.on('unhandledRejection', r => console.error("异步异常：", r.message));
