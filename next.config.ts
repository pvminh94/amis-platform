import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Cho phép preview host của môi trường này truy cập dev server
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  // ---------------------------------------------------------------------------
  // `standalone`: build ra .next/standalone/server.js kèm ĐÚNG những gói nó cần,
  // thay vì cả node_modules. Image chạy vì thế nhỏ hơn nhiều lần.
  //
  // Hệ quả phải nhớ: drizzle-kit và tsx KHÔNG có trong standalone (chúng là
  // devDependency và không được trace). Nên migration và seed chạy ở TẦNG
  // BUILDER của Dockerfile, qua service `migrate` riêng — không phải trong app.
  // ---------------------------------------------------------------------------
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  webpack: (config) => {
    // -----------------------------------------------------------------------
    // Code trong src/ viết theo ESM chuẩn: import './schema.js' dù file thật
    // là schema.ts. Node thuần và tsx BẮT BUỘC phải có extension như vậy.
    //
    // Webpack thì không tự hiểu quy ước đó, nên nó đi tìm file schema.js thật
    // và báo "Module not found". `extensionAlias` bảo webpack: gặp .js thì thử
    // .ts/.tsx trước.
    //
    // Cách khác là bỏ hết extension trong import — nhưng như thế code sẽ không
    // chạy được dưới node thuần (chỉ chạy qua bundler), và ta mất khả năng
    // chạy script/test trực tiếp bằng tsx. Giữ extension đúng chuẩn ESM tốt hơn.
    // -----------------------------------------------------------------------
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
