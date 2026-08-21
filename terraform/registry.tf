# Artifact Registry: where the built images live.
#
# Artifact Registry, not Container Registry (gcr.io). GCR is deprecated and
# shut down in 2025; anything still pointing at gcr.io is following a
# tutorial older than it looks. The containerregistry API is enabled in
# this project only because GKE pulls it in as a dependency -- nothing here
# writes to it.

resource "google_artifact_registry_repository" "shotiq" {
  # Repositories are REGIONAL. Keeping this in the same region as the
  # cluster is not cosmetic: a cross-region pull is billed egress and adds
  # latency to every pod start, and a node pool that scales up during a
  # traffic spike pulls images at the worst possible moment.
  location      = var.region
  repository_id = local.name_prefix
  format        = "DOCKER"

  description = "Container images for ShotIQ, pushed by CI and pulled by GKE."

  # --- cost control -----------------------------------------------------
  #
  # Registry storage is the one line item that survives `terraform
  # destroy` when the repo itself is kept, and it is charged per GB per
  # month for as long as the bytes exist. Nobody notices it, because it
  # accrues in cents while the cluster is what looks expensive.
  #
  # CI pushes an image per commit. Without a policy that is unbounded
  # growth: the ShotIQ images are roughly 1.5 GB per full set, so a
  # hundred commits is well past a hundred gigabytes of layers that
  # nothing will ever pull again.
  #
  # This must be false for the policies to actually delete. Set true, they
  # only log what they would have removed -- which is the right way to try
  # a new policy out, and the wrong way to leave it.
  cleanup_policy_dry_run = false

  # Order does not matter here: KEEP always wins over DELETE, so the two
  # policies below cannot fight. Untagged layers go after a week, but the
  # five most recent versions are exempt regardless.
  cleanup_policies {
    id     = "delete-untagged-after-7-days"
    action = "DELETE"
    condition {
      # An UNTAGGED image is one that was superseded: a later push reused
      # its tag, leaving the old layers addressable only by digest.
      # Nothing deploys these, but they are billed exactly the same.
      tag_state = "UNTAGGED"

      # Seconds, as a string -- the API takes a duration, not a count of
      # days. 604800 is seven. Not zero: a rollback to the previous image
      # needs the previous image to still be there.
      older_than = "604800s"
    }
  }

  cleanup_policies {
    id     = "keep-5-most-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
}
