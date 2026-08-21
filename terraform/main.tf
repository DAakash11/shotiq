# Provider configuration, and a single read-only lookup.
#
# This configuration deliberately creates NOTHING yet. It exists so the
# init/plan/apply cycle and the state file can be seen working on
# something that cannot cost money or break.

# A PROVIDER is the plugin that knows how to talk to one API. Terraform
# core understands dependency graphs, state and the plan/apply cycle and
# nothing else; every actual resource type is contributed by a provider.
# That separation is why the same tool drives GCP, Cloudflare and GitHub.
provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  # No credentials argument, and that is the point. Left unset, the
  # provider falls back to Application Default Credentials: the file
  # written by `gcloud auth application-default login` locally, and the
  # runner's federated identity in CI. The same config authenticates in
  # both places because neither one is named here.
  #
  # The alternative -- credentials = file("key.json") -- hardcodes a path
  # to a downloaded service account key. That key is a permanent,
  # non-expiring credential in a file that gets copied, committed and
  # emailed. Never introduced here, so it can never leak.
}

# A DATA SOURCE reads something that already exists. It is the read-only
# half of the provider: no create, no update, no destroy, and it never
# appears in a plan as a change.
#
# This one earns its place as a live proof of the whole chain -- that
# credentials were found, that they are accepted, and that they can see
# this specific project. If any link is broken, `plan` fails here with a
# real error instead of succeeding emptily and misleading you into
# thinking auth works.
data "google_project" "this" {
  project_id = var.project_id
}
