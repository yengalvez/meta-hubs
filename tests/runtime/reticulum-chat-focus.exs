# Exact existing controller cases, not a second implementation of their oracle.
# HTTP transport is a test client: this does NOT prove provider/network abort.
defmodule Ret.LocalChatFocus do
  def configure!(profile) do
    names = names!(profile)
    Code.require_file("test/ret_web/controllers/api/bot_controller_test.exs")
    tests = RetWeb.BotControllerTest.__ex_unit__().tests

    selected =
      Enum.filter(tests, fn test ->
        Enum.any?(names, &(Atom.to_string(test.name) == "test " <> &1))
      end)

    unless length(selected) == length(names) and
             Enum.all?(names, fn name ->
               Enum.count(selected, &(Atom.to_string(&1.name) == "test " <> name)) == 1
             end) do
      raise "exact existing chat cases missing or duplicated"
    end

    # ExUnit's exact :test tag filter, not a line or a broad substring. Verify
    # selection before execution, then require the exact excluded/total counts.
    ExUnit.configure(exclude: [:test], include: Enum.map(selected, &{:test, &1.name}))
    {length(selected), length(tests), length(tests) - length(selected)}
  end

  defp names!("chat-canary") do
    [
      interruption(:chat_off),
      "a delivered bot command carries the exact current database fence"
    ]
  end

  defp names!("chat-boundaries") do
    Enum.map([:presence, :bots_off, :module_off, :off_on], &interruption/1) ++
      ["a quarantine during the provider call discards the stale reply and action"]
  end

  defp names!(_profile), do: raise("explicit existing chat focus required")

  defp interruption(kind),
    do: "rejects delivery and action after #{kind} during the provider request"
end
