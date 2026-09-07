export default function Custom500() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="safe-y flex min-h-screen flex-col items-center justify-center bg-dark-bg-primary px-4"
    >
      <div className="max-w-md text-center">
        <div className="mb-8">
          <img
            src="/favicon.png"
            alt="Daedalus"
            className="h-16 w-auto mx-auto"
          />
        </div>
        <h1 className="mb-2 text-6xl font-bold text-dark-text-primary">500</h1>
        <p className="mb-8 text-lg text-dark-text-muted">
          Something Went Wrong
        </p>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-on-action bg-action rounded-xl hover:brightness-95 transition-colors duration-200"
        >
          Try Again
        </button>
      </div>
    </main>
  );
}
