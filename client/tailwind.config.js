/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff1ef',
          100: '#ffe1dc',
          200: '#ffc2b8',
          300: '#ff8c78',
          400: '#FA4028',
          500: '#e7331e',
          600: '#cf2d1a',
          700: '#a92213',
          800: '#74190f',
          900: '#4f120b',
          950: '#2e0b06',
        },
      },
    },
  },
  plugins: [],
};
