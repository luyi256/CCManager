module.exports = {
  apps: [
    {
      // API server + web (Express + Socket.IO). Reads <DATA_PATH>/secrets.env
      // itself; DATA_PATH/STATIC_PATH/SERVE_STATIC are set here so a fresh
      // `pm2 start ecosystem.config.cjs` uses the real data dir and serves the SPA.
      name: 'ccm-server',
      cwd: './packages/server',
      script: 'dist/index.js',
      out_file: '/tmp/ccm-server.log',
      error_file: '/tmp/ccm-server.log',
      merge_logs: true,
      env: {
        DATA_PATH: '/home/CC/CCManagerData',
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
