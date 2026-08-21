# Version constraints for Terraform itself and every provider used.
#
# Kept in its own file rather than inside main.tf because it is the one
# thing a reader checks before running anything, and because it changes on
# a completely different schedule to the resources.

terraform {
  # Terraform is not backwards compatible across majors, and 1.x configs
  # will not run on a hypothetical 2.x. Pinning the floor at the version
  # this was written against says "these features exist"; leaving the
  # ceiling open says "later 1.x releases are fine", which the project's
  # own compatibility promise makes true.
  required_version = ">= 1.11.0"

  required_providers {
    google = {
      # The namespace matters. Providers are addressed as
      # <registry>/<namespace>/<name>, and there are community forks of
      # nearly everything -- writing the source explicitly is what stops
      # `google` resolving to somebody else's build.
      source = "hashicorp/google"

      # Pessimistic constraint: ~> 7.45 allows 7.46, 7.99 and any later
      # 7.x, but refuses 8.0. Providers follow semver, so a major bump is
      # where resource arguments get renamed or removed -- exactly the
      # change that should require a human to read the upgrade guide
      # rather than arriving silently on a Tuesday.
      #
      # 7.45.0 was current when this was written, and was checked against
      # the registry rather than recalled. Provider versions move fast
      # enough that a remembered one is usually a major behind.
      version = "~> 7.45"
    }
  }
}
