/// Profile boundary. Implementations read the session token / session id and
/// store the resulting profile id back into the session; they throw a [Failure]
/// on error (including a profile-extraction timeout).
abstract interface class ProfileRepository {
  /// Runs the async extraction job and returns the ready profile id (also
  /// stored in the session).
  Future<String> extractProfile();

  /// Confirms the extracted profile so the resume can be generated.
  ///
  /// Returns the server's post-confirm destination (`next`):
  /// `"trade_form"` for a form-sourced profile, `"chat_complete"` for a
  /// chat-sourced one (straight to resume building), or `null` on an older
  /// server / a pre-migration row — the caller then keeps today's
  /// `GET /profiling/form` probe. Additive: absent `next` → null.
  Future<String?> confirmProfile();
}
