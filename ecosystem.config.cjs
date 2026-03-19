const DATA_PATH = process.env.DATA_PATH || require('path').resolve(__dirname, 'data');

module.exports = {
  apps: [
    {
      name: 'ccm-agent',
      cwd: './packages/agent',
      script: 'npm',
      args: 'run dev',
      out_file: '/tmp/ccm-agent.log',
      error_file: '/tmp/ccm-agent.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000
    },
    {
      name: 'ccm-tunnel',
      script: './tunnel-notify.sh',
      env: { DATA_PATH },
      out_file: '/tmp/ccm-tunnel.log',
      error_file: '/tmp/ccm-tunnel.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 3000
    },
    {
      name: 'ccm-watchdog',
      script: './tunnel-watchdog.sh',
      out_file: '/tmp/ccm-watchdog.log',
      error_file: '/tmp/ccm-watchdog.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000
    }
  ]
};
