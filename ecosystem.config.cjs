module.exports = {
  apps: [
    {
      name: 'ccm-server',
      cwd: './packages/server',
      script: 'npm',
      args: 'run start',
      env: {
        SERVE_STATIC: 'true',
        STATIC_PATH: '/home/CC/CCManager/packages/web/dist_new',
        DATA_PATH: '/home/CC/CCManagerData',
        SSL_KEY: '/home/CC/CCManagerData/certs/key.pem',
        SSL_CERT: '/home/CC/CCManagerData/certs/cert.pem',
        HTTPS_PORT: '3443'
      },
      out_file: '/home/CC/logs/ccm-server.log',
      error_file: '/home/CC/logs/ccm-server.log',
      merge_logs: true,
      autorestart: true
    },
    {
      name: 'ccm-agent',
      cwd: './packages/agent',
      script: 'npm',
      args: 'run start',
      out_file: '/home/CC/logs/ccm-agent.log',
      error_file: '/home/CC/logs/ccm-agent.log',
      merge_logs: true,
      autorestart: true
    }
  ]
};
