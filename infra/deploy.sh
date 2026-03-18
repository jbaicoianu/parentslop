#!/bin/bash
set -euo pipefail

# --- Configuration ---
REGION=us-west-2
STACK_NAME=parentslop
IMAGE_TAG=${1:-latest}

echo "=== ParentSlop Deploy ==="
echo "Region: $REGION"
echo "Image tag: $IMAGE_TAG"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/parentslop"

# --- Resolve VPC + Subnets (default VPC) ---
echo ""
echo "--- Looking up default VPC ---"
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

if [ "$VPC_ID" = "None" ]; then
  echo "ERROR: No default VPC found in $REGION. Specify VPC_ID manually."
  exit 1
fi
echo "VPC: $VPC_ID"

SUBNET_IDS=$(aws ec2 describe-subnets --region "$REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" Name=map-public-ip-on-launch,Values=true \
  --query 'Subnets[:2].SubnetId' --output text | tr '\t' ',')

if [ -z "$SUBNET_IDS" ]; then
  SUBNET_IDS=$(aws ec2 describe-subnets --region "$REGION" \
    --filters Name=vpc-id,Values="$VPC_ID" \
    --query 'Subnets[:2].SubnetId' --output text | tr '\t' ',')
fi
echo "Subnets: $SUBNET_IDS"

# --- Resolve Route 53 Hosted Zone IDs ---
echo ""
echo "--- Looking up hosted zones ---"
HZ_PARENTSLOP=$(aws route53 list-hosted-zones-by-name \
  --dns-name parentslop.com --max-items 1 \
  --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')
HZ_PPLAP=$(aws route53 list-hosted-zones-by-name \
  --dns-name pplap.com --max-items 1 \
  --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')
echo "parentslop.com zone: $HZ_PARENTSLOP"
echo "pplap.com zone:      $HZ_PPLAP"

# --- Find ACM certificate (must be in us-east-1 for CloudFront) ---
echo ""
echo "--- Looking up ACM certificate in us-east-1 ---"
# Use CERT_ARN env var if set, otherwise auto-discover
if [ -z "${CERT_ARN:-}" ]; then
  CERT_ARN=$(aws acm list-certificates --region us-east-1 --certificate-statuses ISSUED \
    --query 'CertificateSummaryList[?SubjectAlternativeNameSummaries[?contains(@,`*.parentslop.com`)] && SubjectAlternativeNameSummaries[?contains(@,`*.pplap.com`)]].CertificateArn | [0]' \
    --output text 2>/dev/null)
fi

if [ "$CERT_ARN" = "None" ] || [ -z "$CERT_ARN" ]; then
  echo "ERROR: No ACM certificate found in us-east-1 covering *.parentslop.com and *.pplap.com"
  echo "Create one with: aws acm request-certificate --region us-east-1 \\"
  echo "  --domain-name parentslop.com --subject-alternative-names '*.parentslop.com' pplap.com '*.pplap.com' \\"
  echo "  --validation-method DNS"
  exit 1
fi
echo "Certificate: $CERT_ARN"

# --- Ensure ECR repo exists and push image first ---
echo ""
echo "--- Ensuring ECR repository ---"
aws ecr describe-repositories --repository-names parentslop --region "$REGION" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name parentslop --region "$REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null
echo "ECR: $ECR_URI"

echo ""
echo "--- Building and pushing Docker image ---"
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

docker build -t "parentslop:$IMAGE_TAG" "$(dirname "$0")/.."
docker tag "parentslop:$IMAGE_TAG" "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:$IMAGE_TAG"

# --- Pre-seed origin DNS record ---
echo ""
echo "--- Pre-seeding origin DNS record ---"
TASK_ARN=$(aws ecs list-tasks --region "$REGION" \
  --cluster parentslop --service parentslop \
  --desired-status RUNNING --query 'taskArns[0]' --output text 2>/dev/null || echo "None")

if [ "$TASK_ARN" != "None" ] && [ -n "$TASK_ARN" ]; then
  ENI_ID=$(aws ecs describe-tasks --region "$REGION" \
    --cluster parentslop --tasks "$TASK_ARN" \
    --query 'tasks[0].attachments[?type==`ElasticNetworkInterface`].details[?name==`networkInterfaceId`].value | [0][0]' \
    --output text)
  if [ "$ENI_ID" != "None" ] && [ -n "$ENI_ID" ]; then
    PUBLIC_IP=$(aws ec2 describe-network-interfaces --region "$REGION" \
      --network-interface-ids "$ENI_ID" \
      --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
    if [ "$PUBLIC_IP" != "None" ] && [ -n "$PUBLIC_IP" ]; then
      echo "Pre-seeding origin.parentslop.com -> $PUBLIC_IP"
      aws route53 change-resource-record-sets \
        --hosted-zone-id "$HZ_PARENTSLOP" \
        --change-batch "{
          \"Changes\": [{
            \"Action\": \"UPSERT\",
            \"ResourceRecordSet\": {
              \"Name\": \"origin.parentslop.com\",
              \"Type\": \"A\",
              \"TTL\": 15,
              \"ResourceRecords\": [{\"Value\": \"$PUBLIC_IP\"}]
            }
          }]
        }"
      echo "DNS pre-seeded."
    else
      echo "WARNING: No public IP found for current task. DNS pre-seed skipped."
    fi
  else
    echo "WARNING: No ENI found for current task. DNS pre-seed skipped."
  fi
else
  echo "NOTE: No running task found (first deploy?). DNS pre-seed skipped."
fi

# --- Deploy CloudFormation stack ---
echo ""
echo "--- Deploying CloudFormation stack ---"
aws cloudformation deploy --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$(dirname "$0")/stack.yml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    SubnetIds="$SUBNET_IDS" \
    HostedZoneIdParentslop="$HZ_PARENTSLOP" \
    HostedZoneIdPplap="$HZ_PPLAP" \
    CertificateArn="$CERT_ARN" \
    ImageTag="$IMAGE_TAG" \
  --no-fail-on-empty-changeset

echo "Stack deployed."

# --- Force new deployment if updating an existing stack ---
echo ""
echo "--- Ensuring latest image is deployed ---"
aws ecs update-service --region "$REGION" \
  --cluster parentslop \
  --service parentslop \
  --force-new-deployment \
  --query 'service.status' --output text

echo ""
echo "=== Deploy complete ==="
aws cloudformation describe-stacks --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
