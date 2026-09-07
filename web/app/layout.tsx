import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Strkret — confidential agent commerce",
  description: "Metered agent commerce settled confidentially on Starknet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
