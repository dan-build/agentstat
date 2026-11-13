cask "agentstat-app" do
  version "@VERSION@"
  sha256 "@DMG_SHA256@"

  url "https://github.com/dan-build/agentstat/releases/download/app-v#{version}/AgentStat-#{version}-macos-universal.dmg"
  name "AgentStat"
  desc "Live status of every AI coding agent on this machine"
  homepage "https://github.com/dan-build/agentstat"

  depends_on macos: ">= :monterey"
  # It links the command the formula installs.
  conflicts_with formula: "agentstat"

  app "AgentStat.app"
  binary "#{appdir}/AgentStat.app/Contents/MacOS/agentstat"
end
