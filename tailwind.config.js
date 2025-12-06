/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}", // 确保加上这一行，让它扫描你的代码
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}

