/** @type {import('next').NextConfig} */
const nextConfig = {
  // StrictMode's dev-only double-mount tears down the WebGL context on the
  // <Canvas>, and the remount can't reacquire one -- the scene renders a single
  // frame, then the lost context paints the canvas opaque white over the page.
  reactStrictMode: false,
  // Type errors fail the build. The project typechecks clean as of the
  // dependency repair -- keep it that way rather than discovering breakage at
  // runtime. Run `npx tsc --noEmit` for the same check without a full build.
  images: {
    unoptimized: true,
  },
}

export default nextConfig
