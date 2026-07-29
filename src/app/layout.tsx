import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DJ Supermercado",
  description: "Load an MP3, read its BPM/key, and shift tempo without changing pitch.",
};

// Mobile-first: pin the viewport so iOS Safari / Android Chrome render the
// single-column touch UI at native width instead of a zoomed-out desktop layout.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
