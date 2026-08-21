#!/usr/bin/env bash
#
# Shut everything down and prove it is gone.
#
#     bash scripts/teardown.sh
#
# Run this at the end of every session. The cluster bills by the hour
# whether or not anyone is looking at it.
#
# The ORDER is the whole point of having a script rather than a note.

set -euo pipefail

PROJECT="${PROJECT:-shotiq-506111}"
REGION="${REGION:-us-central1}"
TF_DIR="$(dirname "$0")/../terraform"

echo "==> Teardown for project: $PROJECT"
echo

# --- 1. Kubernetes-owned cloud resources, FIRST -------------------------
#
# This is the step that gets skipped, and it is the one that costs money.
#
# A Service of type LoadBalancer is created by KUBERNETES, not Terraform.
# GKE's cloud controller calls the Compute API and provisions a forwarding
# rule, a target pool and an IP address. Terraform never saw any of it, so
# none of it is in state and `terraform destroy` will not touch it.
#
# Destroy the cluster first and the controller that would have cleaned up
# is deleted before it can. The forwarding rule survives, attached to
# nothing, billing about $0.025/hour indefinitely -- roughly $18 a month
# for a load balancer pointing at a cluster that no longer exists.
#
# Deleting the Services while the cluster is still alive lets the
# controller do its own cleanup properly.
if kubectl cluster-info >/dev/null 2>&1; then
  echo "==> Deleting LoadBalancer Services (releases forwarding rules and IPs)"
  kubectl delete svc --all --all-namespaces --ignore-not-found=true || true

  # The Compute API call is asynchronous. kubectl returns as soon as the
  # object is gone from etcd, which is before GCP has finished releasing
  # the forwarding rule.
  echo "    waiting 30s for GCP to release the load balancer..."
  sleep 30
else
  echo "==> No reachable cluster (already gone, or kubectl not configured). Skipping."
fi
echo

# --- 2. Everything Terraform owns ---------------------------------------
echo "==> terraform destroy"
terraform -chdir="$TF_DIR" destroy -auto-approve
echo

# --- 3. Prove it, rather than assume it ---------------------------------
#
# `destroy` reporting success means Terraform deleted what was in ITS
# state. It says nothing about resources created by something else -- which
# is exactly the category that leaks. Ask the API directly.
echo "==> Checking for leftovers that would keep billing"

echo "--- forwarding rules (should be empty) ---"
gcloud compute forwarding-rules list --project="$PROJECT" 2>/dev/null || true

echo "--- reserved static IPs (should be empty) ---"
# An UNATTACHED reserved address costs MORE per hour than an attached one.
# GCP prices it that way on purpose, to discourage hoarding addresses.
gcloud compute addresses list --project="$PROJECT" 2>/dev/null || true

echo "--- persistent disks (should be empty) ---"
# A PersistentVolumeClaim provisions a real GCE disk. Depending on the
# StorageClass reclaim policy, deleting the PVC does not always delete it.
gcloud compute disks list --project="$PROJECT" 2>/dev/null || true

echo "--- clusters (should be empty) ---"
gcloud container clusters list --project="$PROJECT" 2>/dev/null || true

echo
echo "==> Still billing by design, and left in place:"
echo "    Artifact Registry images -- cleanup policies cap the growth."
echo "    Check size:  gcloud artifacts repositories describe shotiq \\"
echo "                   --location=$REGION --project=$PROJECT"
echo
echo "==> Teardown complete."
