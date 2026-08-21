# Inputs to this configuration.
#
# Declarations only. The values live in terraform.tfvars, which is
# gitignored -- so this file describes the SHAPE of an environment and
# says nothing about which one. That split is what makes the same config
# deployable twice.

variable "project_id" {
  description = "GCP project ID (not the display name -- the globally unique one)."
  type        = string

  # A validation block turns a wrong value into an error at plan time,
  # before a single API call. Without it, a display name typed here comes
  # back from GCP as a 403, which reads like a permissions problem and
  # sends you looking in entirely the wrong place.
  #
  # Project IDs are 6-30 characters, lowercase letters, digits and
  # hyphens, must start with a letter and cannot end with one.
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project ID: 6-30 chars, lowercase letters, digits and hyphens, starting with a letter. You may have used the project's display name by mistake."
  }
}

variable "region" {
  description = "GCP region for regional resources (the Artifact Registry repo, the VPC subnet)."
  type        = string

  # us-central1 is among the cheapest regions and is where GCP's free
  # tiers are most generous. The trade-off is latency: it is a long way
  # from South Asia, so the dashboard will feel slower than it does on
  # localhost. That is the right trade for a demo billed against trial
  # credit -- asia-south1 (Mumbai) would respond faster and cost roughly
  # 15-20% more per node-hour.
  default = "us-central1"
}

variable "zone" {
  description = "Zone for the GKE cluster's control plane and nodes."
  type        = string

  # A ZONE is one datacentre; a REGION is several zones close together.
  # The cluster is deliberately zonal rather than regional: a regional
  # cluster replicates the control plane across three zones and multiplies
  # the node count to match, which is correct for production and roughly
  # three times the cost of a demo that has no users to keep online.
  default = "us-central1-a"
}
