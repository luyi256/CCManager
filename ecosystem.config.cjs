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
      env: {
        QWEN_CODE_SUPPRESS_YOLO_WARNING: '1'
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000
    }
  ]
};
