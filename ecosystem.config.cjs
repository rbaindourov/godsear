module.exports = {
  apps: [
    {
      name: 'godsear',
      cwd: '/opt/godsear',
      script: './node_modules/.bin/tsx',
      args: 'server/index.ts',
      env: {
        NODE_ENV: 'production',
        PORT: '3012',
      },
    },
  ],
};
