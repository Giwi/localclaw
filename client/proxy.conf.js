export default {
  '/api': {
    target: 'http://localhost:4173',
    changeOrigin: true,
  },
  '/ws': {
    target: 'http://localhost:4173',
    ws: true,
  },
}
