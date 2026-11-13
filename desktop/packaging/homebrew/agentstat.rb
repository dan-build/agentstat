class Agentstat < Formula
  desc "Live status of every AI coding agent on this machine (command line and local service)"
  homepage "https://github.com/dan-build/agentstat"
  version "@VERSION@"
  license "MIT"

  url "https://github.com/dan-build/agentstat/releases/download/app-v@VERSION@/agentstat-@VERSION@-macos-universal.tar.gz"
  sha256 "@TARBALL_SHA256@"

  depends_on macos: :monterey

  # The app's cask links the same command.
  conflicts_with cask: "agentstat-app"

  def install
    bin.install "agentstat"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agentstat --version")
  end
end
