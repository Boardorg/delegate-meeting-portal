import type { NextConfig } from "next";

//adding browser to terminal for development for now. Feel free to remove later
const nextConfig: NextConfig = {
    logging: {
        browserToTerminal: true,
    },
};

export default nextConfig;
