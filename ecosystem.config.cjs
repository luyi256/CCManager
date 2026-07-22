module.exports = {
  apps: [
    {
      // API server + web (Express + Socket.IO). Reads .env (DATA_PATH/PORT/HOST)
      // and <DATA_PATH>/secrets.env itself; only STATIC_PATH/SERVE_STATIC are
      // supplied here so a fresh `pm2 start ecosystem.config.cjs` serves the SPA.
      name: 'ccm-server',
      cwd: './packages/server',
      script: 'dist/index.js',
      out_file: '/tmp/ccm-server.log',
      error_file: '/tmp/ccm-server.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        SERVE_STATIC: 'true',
        STATIC_PATH: '/home/CC/CCManager/packages/web/dist'
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000
    },
    {
      name: 'ccm-agent',
      cwd: './packages/agent',
      script: 'npm',
      args: 'run dev',
      out_file: '/tmp/ccm-agent.log',
      error_file: '/tmp/ccm-agent.log',
      merge_logs: true,
      env: {
        QWEN_CODE_SUPPRESS_YOLO_WARNING: '1'
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000
    }
  ]
};
