// Route group: auth pages render WITHOUT the dashboard sidebar/chrome.
// The root layout still provides <html>/<body>; this layout just centers
// the form card.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full">
      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6 py-12">
        {children}
      </div>
    </div>
  );
}
