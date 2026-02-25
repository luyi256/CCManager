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
    }
  ]
};
