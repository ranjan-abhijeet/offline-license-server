/** @type {import('next').NextConfig} */
export default {
  basePath: '/license', // Caddy routes /license/* here without stripping the prefix
  output: 'standalone',
};
