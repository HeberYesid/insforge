import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InsForge Auth Todo",
  description: "A per-user todo app with InsForge Auth, Google OAuth, and row level security.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark">
      <body className="min-h-screen bg-slate-950 text-slate-50 antialiased">
        {children}
      </body>
    </html>
  );
}
